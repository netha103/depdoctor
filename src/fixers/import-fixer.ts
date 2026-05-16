/**
 * AST-based import fixer — removes unused import declarations and specifiers
 * from source files while preserving the original formatting as much as
 * possible, via recast.
 *
 * Only `high`-confidence issues (fully unused entire import declarations) are
 * applied automatically.  Partial specifier removal (`unused-specifier`) is
 * also handled but treated as medium confidence.
 */

import * as recast from 'recast';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ImportIssue } from '../types.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ImportFixResult {
  file: string;
  original: string;
  modified: string;
  applied: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// AST node types (subset needed for import manipulation)
// ---------------------------------------------------------------------------

interface Position {
  line: number;
  column: number;
}

interface SourceLocation {
  start: Position;
  end: Position;
}

interface BaseNode {
  type: string;
  loc?: SourceLocation | null;
}

interface ImportSpecifierNode extends BaseNode {
  type: 'ImportSpecifier';
  local: { name: string };
  imported: { name: string } | { value: string };
}

interface ImportDefaultSpecifierNode extends BaseNode {
  type: 'ImportDefaultSpecifier';
  local: { name: string };
}

interface ImportNamespaceSpecifierNode extends BaseNode {
  type: 'ImportNamespaceSpecifier';
  local: { name: string };
}

type AnyImportSpecifier =
  | ImportSpecifierNode
  | ImportDefaultSpecifierNode
  | ImportNamespaceSpecifierNode;

interface ImportDeclarationNode extends BaseNode {
  type: 'ImportDeclaration';
  source: { value: string };
  specifiers: AnyImportSpecifier[];
}

interface ProgramNode extends BaseNode {
  type: 'Program';
  body: BaseNode[];
}

interface FileNode extends BaseNode {
  type: 'File';
  program: ProgramNode;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the local name of any import specifier node.
 */
function localName(spec: AnyImportSpecifier): string {
  return spec.local.name;
}

/**
 * Return the 1-based start line of a node (0 when absent).
 */
function nodeLine(node: BaseNode): number {
  return node.loc?.start.line ?? 0;
}

/**
 * Group import issues by their file path.
 */
function groupByFile(issues: ImportIssue[]): Map<string, ImportIssue[]> {
  const map = new Map<string, ImportIssue[]>();
  for (const issue of issues) {
    const existing = map.get(issue.file);
    if (existing !== undefined) {
      existing.push(issue);
    } else {
      map.set(issue.file, [issue]);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Per-file fix logic
// ---------------------------------------------------------------------------

/**
 * Apply import fixes to a single file's source code.
 *
 * Returns the modified source string plus a flag indicating whether any
 * changes were made.
 */
function applyFixesToSource(
  source: string,
  issues: ImportIssue[],
  filePath: string,
): { modified: string; changed: boolean } {
  // Build lookup structures:
  //   - wholeImportLines: line numbers of `unused-import` issues (remove entire decl)
  //   - specifiersByLine: line → Set of specifier names to remove
  const wholeImportLines = new Set<number>();
  const specifiersByLine = new Map<number, Set<string>>();

  for (const issue of issues) {
    if (issue.type === 'unused-import') {
      wholeImportLines.add(issue.line);
    } else if (issue.type === 'unused-specifier' && issue.specifier !== undefined) {
      const existing = specifiersByLine.get(issue.line);
      if (existing !== undefined) {
        existing.add(issue.specifier);
      } else {
        specifiersByLine.set(issue.line, new Set([issue.specifier]));
      }
    }
  }

  // Parse with recast using the babel parser so TypeScript syntax is supported.
  let ast: FileNode;
  try {
    ast = recast.parse(source, {
      parser: require('recast/parsers/babel'),
    }) as FileNode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`ImportFixer: failed to parse "${filePath}": ${msg}`);
    return { modified: source, changed: false };
  }

  const program = ast.program;
  const newBody: BaseNode[] = [];
  let changed = false;

  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration') {
      newBody.push(node);
      continue;
    }

    const importNode = node as ImportDeclarationNode;
    const line = nodeLine(importNode);

    // ── Remove the entire import declaration ─────────────────────────────
    if (wholeImportLines.has(line)) {
      logger.debug(`ImportFixer: removing whole import at line ${line} in "${filePath}"`);
      changed = true;
      // Do NOT push to newBody → node is dropped.
      continue;
    }

    // ── Remove specific specifiers ───────────────────────────────────────
    const specsToRemove = specifiersByLine.get(line);
    if (specsToRemove !== undefined && specsToRemove.size > 0) {
      const before = importNode.specifiers.length;
      importNode.specifiers = importNode.specifiers.filter(
        (spec) => !specsToRemove.has(localName(spec)),
      );
      const after = importNode.specifiers.length;

      if (after < before) {
        changed = true;
        logger.debug(
          `ImportFixer: removed ${before - after} specifier(s) at line ${line} in "${filePath}"`,
        );
      }

      // If all specifiers were removed, drop the whole declaration.
      if (importNode.specifiers.length === 0) {
        logger.debug(`ImportFixer: all specifiers removed — dropping import at line ${line}`);
        continue;
      }
    }

    newBody.push(importNode);
  }

  if (!changed) {
    return { modified: source, changed: false };
  }

  program.body = newBody;

  const printResult = recast.print(ast as unknown as recast.types.ASTNode);
  return { modified: printResult.code, changed: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fix unused imports across all files referenced in `importIssues`.
 *
 * - When `dryRun` is true, files are not modified; the `modified` field of
 *   each result shows what *would* be written.
 * - Only `high`-confidence fixes are applied: fully-unused import declarations
 *   (`unused-import`) and individual unused specifiers (`unused-specifier`).
 *
 * @returns One `ImportFixResult` per file that had issues.
 */
export async function fixUnusedImports(
  importIssues: ImportIssue[],
  dryRun: boolean,
): Promise<ImportFixResult[]> {
  const results: ImportFixResult[] = [];

  if (importIssues.length === 0) {
    return results;
  }

  const byFile = groupByFile(importIssues);

  for (const [filePath, issues] of byFile) {
    const absolutePath = path.resolve(filePath);

    // Read source.
    let source: string;
    try {
      source = fs.readFileSync(absolutePath, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`ImportFixer: cannot read "${absolutePath}": ${msg}`);
      results.push({
        file: filePath,
        original: '',
        modified: '',
        applied: false,
        reason: `Cannot read file: ${msg}`,
      });
      continue;
    }

    const { modified, changed } = applyFixesToSource(source, issues, absolutePath);

    if (!changed) {
      results.push({
        file: filePath,
        original: source,
        modified: source,
        applied: false,
        reason: 'No changes produced by AST transformation',
      });
      continue;
    }

    if (dryRun) {
      logger.info(`ImportFixer (dry-run): would modify "${filePath}"`);
      results.push({
        file: filePath,
        original: source,
        modified,
        applied: false,
        reason: 'Dry run — file not written',
      });
      continue;
    }

    // Write modified source.
    try {
      fs.writeFileSync(absolutePath, modified, 'utf-8');
      logger.success(`ImportFixer: fixed "${filePath}"`);
      results.push({
        file: filePath,
        original: source,
        modified,
        applied: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`ImportFixer: failed to write "${absolutePath}": ${msg}`);
      results.push({
        file: filePath,
        original: source,
        modified,
        applied: false,
        reason: `Write failed: ${msg}`,
      });
    }
  }

  return results;
}
