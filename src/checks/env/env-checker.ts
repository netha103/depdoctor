import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config, EnvIssue } from '../../types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * All .env file variants that are commonly used in Node.js projects.
 * Checked in the order listed; the list is not exhaustive but covers the
 * patterns popularised by Create React App, Vite, Next.js, and dotenv.
 */
const ENV_FILE_NAMES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.test',
  '.env.test.local',
  '.env.production',
  '.env.production.local',
  '.env.staging',
  '.env.staging.local',
  '.env.ci',
  '.env.example',
  '.env.sample',
  '.env.defaults',
  '.env.override',
];

/**
 * A valid environment variable name must consist only of uppercase letters,
 * digits, and underscores, and must not start with a digit.
 *
 * This is the POSIX / shell convention (often referred to as SCREAMING_SNAKE_CASE).
 * Variable names starting with a digit are invalid in most shells; leading
 * underscores are intentionally allowed (e.g. `_INTERNAL_FLAG`).
 */
const VALID_ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

// ─── Types ───────────────────────────────────────────────────────────────────

interface EnvEntry {
  name: string;
  value: string;
  line: number;
  file: string;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a single .env file and return all valid key=value pairs with their
 * line numbers.  Handles:
 * - blank lines and comment lines (`#`)
 * - optional `export` prefix
 * - quoted values (single or double quotes, with basic escape handling)
 * - inline comments after an unquoted value
 */
function parseEnvFile(filePath: string): EnvEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const entries: EnvEntry[] = [];
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // Skip blank lines and comments.
    if (line === '' || line.startsWith('#')) continue;

    // Strip optional `export ` prefix.
    const stripped = line.startsWith('export ') ? line.slice(7).trim() : line;

    // Require KEY=VALUE structure.
    const eqIndex = stripped.indexOf('=');
    if (eqIndex === -1) continue;

    const name = stripped.slice(0, eqIndex).trim();
    if (name === '') continue;

    const rawValue = stripped.slice(eqIndex + 1);

    // Strip inline comments from unquoted values and resolve quoted values.
    const value = parseEnvValue(rawValue);

    entries.push({ name, value, line: i + 1, file: filePath });
  }

  return entries;
}

/**
 * Strip quotes and inline comments from an env file value token.
 */
function parseEnvValue(raw: string): string {
  const trimmed = raw.trim();

  // Double-quoted value.
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }

  // Single-quoted value.
  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }

  // Unquoted — strip inline comment (# preceded by whitespace).
  const commentIndex = trimmed.search(/\s#/);
  return commentIndex === -1 ? trimmed : trimmed.slice(0, commentIndex).trimEnd();
}

// ─── Analysis ────────────────────────────────────────────────────────────────

/**
 * Returns true when the variable name is a valid POSIX / SCREAMING_SNAKE_CASE
 * identifier.
 */
function isValidEnvName(name: string): boolean {
  return VALID_ENV_NAME_RE.test(name);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan all .env files in `projectRoot` and return `EnvIssue` records for:
 *
 * - **duplicate** — the same variable name is declared in more than one .env
 *   file (across files; within a single file only the first occurrence is
 *   canonical).
 * - **invalid-name** — a variable name that does not conform to
 *   SCREAMING_SNAKE_CASE (upper-case letters, digits, underscores only;
 *   must not start with a digit).
 *
 * Files and variables matching `config.ignoreFiles` / `config.ignoreVariables`
 * are silently skipped.
 */
export function checkEnv(
  projectRoot: string,
  config: Config,
): EnvIssue[] {
  const issues: EnvIssue[] = [];

  // ── Collect all entries from all .env files ─────────────────────────────
  const allEntries: EnvEntry[] = [];
  const seenInFile = new Map<string, Set<string>>();   // file → names seen

  for (const fileName of ENV_FILE_NAMES) {
    const filePath = path.join(projectRoot, fileName);
    if (!fs.existsSync(filePath)) continue;

    // Apply ignoreFiles config.
    if (isFileIgnored(filePath, config.ignoreFiles)) continue;

    const entries = parseEnvFile(filePath);
    const seenNames = new Set<string>();

    for (const entry of entries) {
      // Apply ignoreVariables config.
      if (isVariableIgnored(entry.name, config.ignoreVariables)) continue;

      // Within a single file, only record the first declaration; subsequent
      // ones in the same file are redundant but we still capture them for
      // the cross-file duplicate check.
      if (!seenNames.has(entry.name)) {
        seenNames.add(entry.name);
        allEntries.push(entry);
      }
    }

    seenInFile.set(filePath, seenNames);
  }

  // ── Cross-file duplicate detection ────────────────────────────────────────
  // Build a map of variable name → list of files that declare it.
  const declarationMap = new Map<string, EnvEntry[]>();
  for (const entry of allEntries) {
    const existing = declarationMap.get(entry.name);
    if (existing !== undefined) {
      existing.push(entry);
    } else {
      declarationMap.set(entry.name, [entry]);
    }
  }

  for (const [varName, declarations] of declarationMap) {
    if (declarations.length > 1) {
      // Emit one issue per duplicate occurrence (all files except the first).
      for (const dup of declarations.slice(1)) {
        issues.push({
          type: 'duplicate',
          variable: varName,
          file: dup.file,
          line: dup.line,
          severity: 'warning',
          description: `"${varName}" is declared in multiple .env files. First seen in "${path.basename(declarations[0].file)}", also declared in "${path.basename(dup.file)}".`,
        });
      }
    }
  }

  // ── Invalid name detection ─────────────────────────────────────────────────
  for (const entry of allEntries) {
    if (!isValidEnvName(entry.name)) {
      issues.push({
        type: 'invalid-name',
        variable: entry.name,
        file: entry.file,
        line: entry.line,
        severity: 'warning',
        description: `"${entry.name}" does not follow SCREAMING_SNAKE_CASE naming convention. Environment variable names should contain only uppercase letters, digits, and underscores, and must not start with a digit.`,
      });
    }
  }

  return issues;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isFileIgnored(filePath: string, ignoreFiles: readonly string[]): boolean {
  const base = path.basename(filePath);
  for (const pattern of ignoreFiles) {
    if (pattern === filePath || pattern === base) return true;
    if (pattern.endsWith('*') && (filePath.startsWith(pattern.slice(0, -1)) || base.startsWith(pattern.slice(0, -1)))) return true;
    if (pattern.startsWith('*') && (filePath.endsWith(pattern.slice(1)) || base.endsWith(pattern.slice(1)))) return true;
  }
  return false;
}

function isVariableIgnored(name: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === name) return true;
    if (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))) return true;
    if (pattern.startsWith('*') && name.endsWith(pattern.slice(1))) return true;
  }
  return false;
}
