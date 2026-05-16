/**
 * Combined import + variable fixer.
 *
 * Applies import removals AND variable declaration removals in a single recast
 * parse → mutate → print cycle, so both operations use the original line
 * numbers and cannot interfere with each other.
 */

import * as recast from 'recast';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ImportIssue, VariableIssue } from '../types.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CombinedFixResult {
  file: string;
  original: string;
  modified: string;
  applied: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Minimal AST node shapes
// ---------------------------------------------------------------------------

interface Position { line: number; column: number }
interface SourceLocation { start: Position; end: Position }
interface BaseNode { type: string; loc?: SourceLocation | null }

interface IdentifierNode extends BaseNode { type: 'Identifier'; name: string }

interface VariableDeclaratorNode extends BaseNode {
  type: 'VariableDeclarator';
  id: BaseNode;
}

interface VariableDeclarationNode extends BaseNode {
  type: 'VariableDeclaration';
  declarations: VariableDeclaratorNode[];
}

interface ImportSpecifierNode extends BaseNode {
  type: 'ImportSpecifier';
  local: { name: string };
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
  specifiers: AnyImportSpecifier[];
}

interface BlockStatementNode extends BaseNode {
  type: 'BlockStatement';
  body: BaseNode[];
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

function nodeLine(node: BaseNode): number {
  return node.loc?.start.line ?? 0;
}

function specifierLocalName(spec: AnyImportSpecifier): string {
  return spec.local.name;
}

/** Recursively walk every BlockStatement in a node tree, applying transform. */
function walkBlockBodies(
  node: BaseNode,
  transform: (body: BaseNode[]) => BaseNode[],
): void {
  const n = node as unknown as Record<string, unknown>;
  for (const key of Object.keys(n)) {
    const child = n[key];
    if (child === null || typeof child !== 'object') continue;

    if ((child as BaseNode).type === 'BlockStatement') {
      const block = child as BlockStatementNode;
      block.body = transform(block.body);
    } else if (Array.isArray(child)) {
      for (const item of child as unknown[]) {
        if (item !== null && typeof item === 'object' && 'type' in (item as object)) {
          walkBlockBodies(item as BaseNode, transform);
        }
      }
    } else if ('type' in (child as object)) {
      walkBlockBodies(child as BaseNode, transform);
    }
  }
}

// ---------------------------------------------------------------------------
// Core: single-pass AST mutation
// ---------------------------------------------------------------------------

function applyAllFixes(
  source: string,
  importIssues: ImportIssue[],
  varIssues: VariableIssue[],
  filePath: string,
): { modified: string; changed: boolean } {
  // ── Build lookup structures from both issue lists ──────────────────────
  const wholeImportLines = new Set<number>();   // lines where entire import is removed
  const importSpecsByLine = new Map<number, Set<string>>(); // line → specifier names
  const varsByLine = new Map<number, Set<string>>();        // line → var names

  for (const issue of importIssues) {
    if (issue.type === 'unused-import') {
      wholeImportLines.add(issue.line);
    } else if (issue.type === 'unused-specifier' && issue.specifier !== undefined) {
      const s = importSpecsByLine.get(issue.line) ?? new Set();
      s.add(issue.specifier);
      importSpecsByLine.set(issue.line, s);
    }
  }

  for (const issue of varIssues) {
    const s = varsByLine.get(issue.line) ?? new Set();
    s.add(issue.name);
    varsByLine.set(issue.line, s);
  }

  // ── Parse ──────────────────────────────────────────────────────────────
  let ast: FileNode;
  try {
    ast = recast.parse(source, {
      parser: require('recast/parsers/babel'),
    }) as FileNode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`CombinedFixer: failed to parse "${filePath}": ${msg}`);
    return { modified: source, changed: false };
  }

  let changed = false;

  // ── Mutation: process a flat body array ────────────────────────────────
  function processBody(body: BaseNode[]): BaseNode[] {
    const out: BaseNode[] = [];

    for (const node of body) {
      const line = nodeLine(node);

      // ── ImportDeclaration ─────────────────────────────────────────────
      if (node.type === 'ImportDeclaration') {
        const importNode = node as ImportDeclarationNode;

        if (wholeImportLines.has(line)) {
          logger.debug(`CombinedFixer: removing import at line ${line}`);
          changed = true;
          continue;
        }

        const specsToRemove = importSpecsByLine.get(line);
        if (specsToRemove !== undefined && specsToRemove.size > 0) {
          const before = importNode.specifiers.length;
          importNode.specifiers = importNode.specifiers.filter(
            (s) => !specsToRemove.has(specifierLocalName(s)),
          );
          if (importNode.specifiers.length < before) {
            changed = true;
            logger.debug(`CombinedFixer: removed specifier(s) at line ${line}`);
          }
          if (importNode.specifiers.length === 0) {
            logger.debug(`CombinedFixer: dropping empty import at line ${line}`);
            continue;
          }
        }

        out.push(node);
        continue;
      }

      // ── VariableDeclaration ───────────────────────────────────────────
      if (node.type === 'VariableDeclaration') {
        const varNode = node as VariableDeclarationNode;
        const targets = varsByLine.get(line);

        if (targets !== undefined && targets.size > 0) {
          const kept = varNode.declarations.filter((d) => {
            if (d.id.type !== 'Identifier') return true;
            return !targets.has((d.id as IdentifierNode).name);
          });

          if (kept.length < varNode.declarations.length) {
            changed = true;
            if (kept.length === 0) {
              logger.debug(`CombinedFixer: dropped var at line ${line}`);
              // Recurse into init expressions before dropping (they may contain blocks).
              walkBlockBodies(node, processBody);
              continue;
            }
            varNode.declarations = kept;
            logger.debug(`CombinedFixer: trimmed var at line ${line}`);
          }
        }
      }

      // Recurse into block bodies of any other node.
      walkBlockBodies(node, processBody);
      out.push(node);
    }

    return out;
  }

  ast.program.body = processBody(ast.program.body);

  if (!changed) return { modified: source, changed: false };

  const printResult = recast.print(ast as unknown as recast.types.ASTNode);
  return { modified: printResult.code, changed: true };
}

// ---------------------------------------------------------------------------
// Group helpers
// ---------------------------------------------------------------------------

function groupImportsByFile(issues: ImportIssue[]): Map<string, ImportIssue[]> {
  const m = new Map<string, ImportIssue[]>();
  for (const i of issues) {
    const l = m.get(i.file) ?? [];
    l.push(i);
    m.set(i.file, l);
  }
  return m;
}

function groupVarsByFile(issues: VariableIssue[]): Map<string, VariableIssue[]> {
  const m = new Map<string, VariableIssue[]>();
  for (const i of issues) {
    const l = m.get(i.file) ?? [];
    l.push(i);
    m.set(i.file, l);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fix unused imports AND unused variables for all affected files in a single
 * recast pass per file, ensuring line numbers stay consistent throughout.
 */
export async function fixImportsAndVars(
  importIssues: ImportIssue[],
  varIssues: VariableIssue[],
  dryRun: boolean,
): Promise<CombinedFixResult[]> {
  const results: CombinedFixResult[] = [];

  const byFileImports = groupImportsByFile(importIssues);
  const byFileVars = groupVarsByFile(varIssues);

  // Union of all files that need any fix.
  const allFiles = new Set([...byFileImports.keys(), ...byFileVars.keys()]);

  for (const filePath of allFiles) {
    const absolutePath = path.resolve(filePath);
    const fileImports = byFileImports.get(filePath) ?? [];
    const fileVars = byFileVars.get(filePath) ?? [];

    let source: string;
    try {
      source = fs.readFileSync(absolutePath, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`CombinedFixer: cannot read "${absolutePath}": ${msg}`);
      results.push({ file: filePath, original: '', modified: '', applied: false, reason: `Cannot read file: ${msg}` });
      continue;
    }

    const { modified, changed } = applyAllFixes(source, fileImports, fileVars, absolutePath);

    if (!changed) {
      results.push({ file: filePath, original: source, modified: source, applied: false, reason: 'No changes produced' });
      continue;
    }

    if (dryRun) {
      logger.info(`CombinedFixer (dry-run): would modify "${filePath}"`);
      results.push({ file: filePath, original: source, modified, applied: false, reason: 'Dry run — file not written' });
      continue;
    }

    try {
      fs.writeFileSync(absolutePath, modified, 'utf-8');
      logger.success(`CombinedFixer: fixed "${filePath}"`);
      results.push({ file: filePath, original: source, modified, applied: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`CombinedFixer: failed to write "${absolutePath}": ${msg}`);
      results.push({ file: filePath, original: source, modified, applied: false, reason: `Write failed: ${msg}` });
    }
  }

  return results;
}
