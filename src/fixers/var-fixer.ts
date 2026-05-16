/**
 * AST-based variable fixer — removes unused variable declarations from source
 * files using recast, preserving original formatting.
 *
 * Handles both top-level and function-body declarations. For multi-declarator
 * statements (`const a = 1, b = 2`) only the unused declarator(s) are removed;
 * the whole statement is dropped when all declarators are unused.
 */

import * as recast from 'recast';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { VariableIssue } from '../types.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VarFixResult {
  file: string;
  original: string;
  modified: string;
  applied: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Minimal AST node types (recast / babel subset)
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
  kind: string;
  declarations: VariableDeclaratorNode[];
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

function groupByFile(issues: VariableIssue[]): Map<string, VariableIssue[]> {
  const map = new Map<string, VariableIssue[]>();
  for (const issue of issues) {
    const list = map.get(issue.file);
    if (list !== undefined) list.push(issue);
    else map.set(issue.file, [issue]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Per-file fix logic
// ---------------------------------------------------------------------------

function applyFixesToSource(
  source: string,
  issues: VariableIssue[],
  filePath: string,
): { modified: string; changed: boolean } {
  // Build a map: line → Set<name> of variables to remove on that line.
  const targetsByLine = new Map<number, Set<string>>();
  for (const issue of issues) {
    const existing = targetsByLine.get(issue.line);
    if (existing !== undefined) existing.add(issue.name);
    else targetsByLine.set(issue.line, new Set([issue.name]));
  }

  let ast: FileNode;
  try {
    ast = recast.parse(source, {
      parser: require('recast/parsers/babel'),
    }) as FileNode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`VarFixer: failed to parse "${filePath}": ${msg}`);
    return { modified: source, changed: false };
  }

  let changed = false;

  function processBody(body: BaseNode[]): BaseNode[] {
    const out: BaseNode[] = [];

    for (const node of body) {
      if (node.type === 'VariableDeclaration') {
        const varNode = node as VariableDeclarationNode;
        const line = nodeLine(varNode);
        const targets = targetsByLine.get(line);

        if (targets !== undefined && targets.size > 0) {
          const kept = varNode.declarations.filter((d) => {
            if (d.id.type !== 'Identifier') return true;
            return !targets.has((d.id as IdentifierNode).name);
          });

          if (kept.length < varNode.declarations.length) {
            changed = true;
            if (kept.length === 0) {
              logger.debug(`VarFixer: dropped declaration at line ${line} in "${filePath}"`);
              continue; // drop entire declaration
            }
            varNode.declarations = kept;
            logger.debug(`VarFixer: trimmed declaration at line ${line} in "${filePath}"`);
          }
        }
      }

      // Recurse into any node that has a block body.
      walkNodeBodies(node, processBody);
      out.push(node);
    }

    return out;
  }

  ast.program.body = processBody(ast.program.body);

  if (!changed) return { modified: source, changed: false };

  const printResult = recast.print(ast as unknown as recast.types.ASTNode);
  return { modified: printResult.code, changed: true };
}

/**
 * Walk into all BlockStatement children of `node` and apply `transform` to
 * their body arrays. Handles: functions, methods, if/else, loops, try/catch.
 */
function walkNodeBodies(
  node: BaseNode,
  transform: (body: BaseNode[]) => BaseNode[],
): void {
  const n = node as unknown as Record<string, unknown>;

  for (const key of Object.keys(n)) {
    const child = n[key];
    if (child === null || typeof child !== 'object') continue;

    if (
      typeof child === 'object' &&
      (child as BaseNode).type === 'BlockStatement'
    ) {
      const block = child as BlockStatementNode;
      block.body = transform(block.body);
    } else if (Array.isArray(child)) {
      for (const item of child as unknown[]) {
        if (item !== null && typeof item === 'object' && 'type' in (item as object)) {
          walkNodeBodies(item as BaseNode, transform);
        }
      }
    } else if (typeof child === 'object' && 'type' in (child as object)) {
      walkNodeBodies(child as BaseNode, transform);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fix unused variable declarations across all files referenced in `varIssues`.
 *
 * @returns One `VarFixResult` per file that had issues.
 */
export async function fixUnusedVars(
  varIssues: VariableIssue[],
  dryRun: boolean,
): Promise<VarFixResult[]> {
  const results: VarFixResult[] = [];
  if (varIssues.length === 0) return results;

  const byFile = groupByFile(varIssues);

  for (const [filePath, issues] of byFile) {
    const absolutePath = path.resolve(filePath);

    let source: string;
    try {
      source = fs.readFileSync(absolutePath, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`VarFixer: cannot read "${absolutePath}": ${msg}`);
      results.push({ file: filePath, original: '', modified: '', applied: false, reason: `Cannot read file: ${msg}` });
      continue;
    }

    const { modified, changed } = applyFixesToSource(source, issues, absolutePath);

    if (!changed) {
      results.push({ file: filePath, original: source, modified: source, applied: false, reason: 'No changes produced' });
      continue;
    }

    if (dryRun) {
      logger.info(`VarFixer (dry-run): would modify "${filePath}"`);
      results.push({ file: filePath, original: source, modified, applied: false, reason: 'Dry run — file not written' });
      continue;
    }

    try {
      fs.writeFileSync(absolutePath, modified, 'utf-8');
      logger.success(`VarFixer: fixed "${filePath}"`);
      results.push({ file: filePath, original: source, modified, applied: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`VarFixer: failed to write "${absolutePath}": ${msg}`);
      results.push({ file: filePath, original: source, modified, applied: false, reason: `Write failed: ${msg}` });
    }
  }

  return results;
}
