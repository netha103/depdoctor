import * as path from 'node:path';
import type { Config, ImportIssue, ParsedFile } from '../../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true when `name` matches any pattern in the ignore list.
 * Patterns may use a leading or trailing `*` as a simple wildcard.
 * The conventional `_`-prefix for intentionally-unused names is handled at
 * the call site before this function is invoked.
 */
function matchesIgnorePattern(name: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === name) return true;
    if (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))) return true;
    if (pattern.startsWith('*') && name.endsWith(pattern.slice(1))) return true;
  }
  return false;
}

/**
 * Returns true when the given file path (absolute or relative) matches any of
 * the ignore-file patterns from config.  Patterns are compared against both
 * the full path and just the basename.
 */
function fileIsIgnored(filePath: string, ignoreFiles: readonly string[]): boolean {
  const base = path.basename(filePath);
  for (const pattern of ignoreFiles) {
    if (pattern === filePath || pattern === base) return true;
    if (pattern.endsWith('*') && (filePath.startsWith(pattern.slice(0, -1)) || base.startsWith(pattern.slice(0, -1)))) return true;
    if (pattern.startsWith('*') && (filePath.endsWith(pattern.slice(1)) || base.endsWith(pattern.slice(1)))) return true;
  }
  return false;
}

/**
 * Returns true when the local binding name should be treated as intentionally
 * unused (starts with `_`, matching the TypeScript / ESLint convention).
 */
function isIntentionallyUnused(name: string): boolean {
  return name.startsWith('_');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Inspect every import in every parsed file and emit `ImportIssue` records for
 * unused imports and unused import specifiers.
 *
 * Rules applied:
 * - Side-effect imports (`import 'module'`) are never flagged.
 * - Re-export sources are never flagged (the specifiers flow into exports).
 * - Namespace imports (`import * as ns`) are checked against `usedIdentifiers`.
 * - Default imports are checked against `usedIdentifiers`.
 * - Named specifiers are checked individually; all must be unused before the
 *   whole statement is emitted as `unused-import`.
 * - Local bindings starting with `_` are treated as intentionally unused.
 * - Local bindings matching `config.ignoreVariables` patterns are skipped.
 * - Files matching `config.ignoreFiles` are skipped entirely.
 */
export function checkImports(
  parsedFiles: ParsedFile[],
  config: Config,
): ImportIssue[] {
  const issues: ImportIssue[] = [];

  for (const file of parsedFiles) {
    if (fileIsIgnored(file.path, config.ignoreFiles)) continue;

    // Build a set of all names that appear as re-export sources so we don't
    // flag them – e.g. `export { foo } from './foo'` should not count as
    // an unused import of './foo'.
    const reExportSources = new Set<string>(
      file.exports
        .filter((e) => e.isReExport && e.source !== undefined)
        .map((e) => e.source as string),
    );

    for (const imp of file.imports) {
      // Side-effect imports are always intentional.
      if (imp.specifiers.length === 0 && !imp.isTypeOnly) continue;

      // Re-exports are not unused imports.
      if (reExportSources.has(imp.source)) continue;

      const unusedSpecifiers: string[] = [];
      const usedSpecifiers: string[] = [];

      for (const spec of imp.specifiers) {
        const localName = spec.local;

        // Conventional unused marker.
        if (isIntentionallyUnused(localName)) continue;

        // User-configured ignore list.
        if (matchesIgnorePattern(localName, config.ignoreVariables)) continue;

        const isUsed = file.usedIdentifiers.has(localName);

        if (isUsed) {
          usedSpecifiers.push(localName);
        } else {
          unusedSpecifiers.push(localName);
        }
      }

      // If every specifier (after skipping ignored ones) is unused, emit a
      // single `unused-import` issue for the whole statement.
      if (unusedSpecifiers.length > 0 && usedSpecifiers.length === 0) {
        issues.push({
          type: 'unused-import',
          file: file.path,
          line: imp.line,
          source: imp.source,
          severity: imp.isTypeOnly ? 'info' : 'warning',
          description: `Unused import from "${imp.source}" — no imported bindings are referenced.`,
        });
        continue;
      }

      // Otherwise emit individual `unused-specifier` issues.
      for (const specName of unusedSpecifiers) {
        issues.push({
          type: 'unused-specifier',
          file: file.path,
          line: imp.line,
          source: imp.source,
          specifier: specName,
          severity: 'info',
          description: `"${specName}" is imported from "${imp.source}" but never used.`,
        });
      }
    }
  }

  return issues;
}
