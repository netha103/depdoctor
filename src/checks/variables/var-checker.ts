import * as path from 'node:path';
import type { Config, VariableIssue, ParsedFile } from '../../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true when `name` matches any pattern in the ignore list.
 * Supports a leading or trailing `*` wildcard.
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
 * Returns true when the file path matches one of the configured ignore patterns.
 * Patterns are compared against both the full path and the basename.
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
 * Returns true when the variable name follows the "intentionally unused"
 * convention (leading underscore), e.g. `_unused`, `_err`.
 */
function isIntentionallyUnused(name: string): boolean {
  return name.startsWith('_');
}

/**
 * Returns true when the variable name is exported from the file.
 * Exported variables are potentially consumed by other modules, so we never
 * flag them as unused within the declaring file.
 */
function isExported(name: string, file: ParsedFile): boolean {
  return file.exports.some((e) => e.name === name);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Inspect every declared variable in each parsed file and return
 * `VariableIssue` records for any that are never referenced.
 *
 * Rules applied:
 * - Variables starting with `_` are treated as intentionally unused (skip).
 * - Variables matching `config.ignoreVariables` patterns are skipped.
 * - Exported variables are skipped (they may be consumed externally).
 * - Files matching `config.ignoreFiles` are skipped entirely.
 * - Severity is `'warning'` for `const` and `'info'` for `let`/`var`
 *   (mutable bindings are more commonly declared speculatively).
 */
export function checkVariables(
  parsedFiles: ParsedFile[],
  config: Config,
): VariableIssue[] {
  const issues: VariableIssue[] = [];

  for (const file of parsedFiles) {
    if (fileIsIgnored(file.path, config.ignoreFiles)) continue;

    for (const variable of file.variables) {
      const { name, kind, line } = variable;

      // Convention: leading underscore = intentionally unused.
      if (isIntentionallyUnused(name)) continue;

      // User-configured ignore patterns.
      if (matchesIgnorePattern(name, config.ignoreVariables)) continue;

      // Exported variables may be used by other modules.
      if (isExported(name, file)) continue;

      // Check whether the name appears anywhere in the file's identifier set.
      if (file.usedIdentifiers.has(name)) continue;

      issues.push({
        type: 'unused-variable',
        file: file.path,
        line,
        name,
        kind,
        // `const` bindings are immutable intent — flag more loudly.
        // `let` / `var` are often declared early and used later; softer signal.
        severity: kind === 'const' ? 'warning' : 'info',
        description: `"${name}" is declared as ${kind} but is never read.`,
      });
    }
  }

  return issues;
}
