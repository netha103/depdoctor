/**
 * Import resolver — classifies raw import/require source strings and resolves
 * TypeScript path aliases.
 *
 * Handles:
 *   - Relative local paths:        './utils', '../lib/foo'
 *   - Node.js built-ins:           'path', 'node:fs', 'fs'
 *   - npm packages (bare):         'lodash'
 *   - npm packages (sub-path):     'lodash/merge'
 *   - Scoped npm packages:         '@babel/core', '@babel/runtime/helpers/foo'
 *   - Virtual / bundler modules:   'virtual:…', '\0…', '/@fs/…'
 *   - tsconfig.json path aliases:  '@app/utils' → './src/utils'
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Node.js built-in module list (Node 18+)
// ---------------------------------------------------------------------------

const NODE_BUILTINS = new Set<string>([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'sys', 'timers', 'timers/promises',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
  // `node:` prefixed variants
  'node:assert', 'node:async_hooks', 'node:buffer', 'node:child_process',
  'node:cluster', 'node:console', 'node:constants', 'node:crypto',
  'node:dgram', 'node:diagnostics_channel', 'node:dns', 'node:domain',
  'node:events', 'node:fs', 'node:http', 'node:http2', 'node:https',
  'node:inspector', 'node:module', 'node:net', 'node:os', 'node:path',
  'node:perf_hooks', 'node:process', 'node:punycode', 'node:querystring',
  'node:readline', 'node:repl', 'node:stream', 'node:string_decoder',
  'node:sys', 'node:timers', 'node:tls', 'node:trace_events', 'node:tty',
  'node:url', 'node:util', 'node:v8', 'node:vm', 'node:wasi',
  'node:worker_threads', 'node:zlib',
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The resolved category of an import source string.
 *
 * - `local`   — relative file path (starts with `.`)
 * - `builtin` — Node.js built-in (bare name or `node:` prefix)
 * - `package` — third-party npm package
 * - `virtual` — bundler-internal virtual module (`virtual:…`, `\0…`, `/@fs/…`)
 * - `unknown` — none of the above (e.g. empty string)
 */
export type ImportKind = 'local' | 'builtin' | 'package' | 'virtual' | 'unknown';

export interface ResolvedImport {
  /** Classification of the import source. */
  kind: ImportKind;

  /**
   * The npm package name when `kind === 'package'`.
   * - Un-scoped: `'lodash'` for `'lodash/merge'`
   * - Scoped:    `'@babel/core'` for `'@babel/runtime/helpers/foo'`
   * Undefined for non-package imports.
   */
  packageName?: string;

  /** The raw source string as it appeared in the source file. */
  rawSource: string;
}

// ---------------------------------------------------------------------------
// Classification predicates
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the source string refers to a Node.js built-in module.
 */
export function isNodeBuiltin(source: string): boolean {
  if (source.startsWith('node:')) return true;
  return NODE_BUILTINS.has(source);
}

/**
 * Returns `true` when the source string is a relative path.
 */
export function isRelativeImport(source: string): boolean {
  return source.startsWith('.');
}

/**
 * Returns `true` when the source string looks like a virtual or bundler-
 * internal module that should never map to an npm package.
 */
export function isVirtualImport(source: string): boolean {
  return (
    source.startsWith('\0') ||
    source.startsWith('virtual:') ||
    source.startsWith('/@fs/')
  );
}

// ---------------------------------------------------------------------------
// Package-name extraction
// ---------------------------------------------------------------------------

/**
 * Given a raw import source string, extract the npm package name.
 *
 * Returns `null` when the source is not an npm package (relative path,
 * built-in, virtual, or empty).
 *
 * @example
 * extractPackageName('lodash')              // => 'lodash'
 * extractPackageName('lodash/merge')        // => 'lodash'
 * extractPackageName('@babel/core')         // => '@babel/core'
 * extractPackageName('@babel/runtime/foo')  // => '@babel/runtime'
 * extractPackageName('./utils')             // => null
 * extractPackageName('node:fs')             // => null
 */
export function extractPackageName(source: string): string | null {
  if (!source) return null;
  if (isRelativeImport(source)) return null;
  if (isNodeBuiltin(source)) return null;
  if (isVirtualImport(source)) return null;

  if (source.startsWith('@')) {
    // Scoped package: take the first two segments (@scope/name).
    const parts = source.split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`;
  }

  // Un-scoped package: everything up to the first '/'.
  const slash = source.indexOf('/');
  return slash === -1 ? source : source.slice(0, slash);
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

/**
 * Classify an import/require source string.
 *
 * @param source  The raw source string from the import declaration.
 * @returns A `ResolvedImport` describing the kind and package name.
 */
export function resolveImport(source: string): ResolvedImport {
  if (!source) {
    return { kind: 'unknown', rawSource: source };
  }

  if (isRelativeImport(source)) {
    return { kind: 'local', rawSource: source };
  }

  if (isNodeBuiltin(source)) {
    return { kind: 'builtin', rawSource: source };
  }

  if (isVirtualImport(source)) {
    return { kind: 'virtual', rawSource: source };
  }

  const packageName = extractPackageName(source);
  if (packageName !== null) {
    return { kind: 'package', packageName, rawSource: source };
  }

  return { kind: 'unknown', rawSource: source };
}

// ---------------------------------------------------------------------------
// tsconfig.json path alias loading
// ---------------------------------------------------------------------------

/**
 * A map of TypeScript path alias patterns to their target glob arrays.
 *
 * Mirrors the shape of `compilerOptions.paths` in tsconfig.json.
 *
 * @example
 * {
 *   '@app/*':     ['./src/*'],
 *   '@utils':     ['./src/utils/index.ts'],
 * }
 */
export interface TsConfigPaths {
  [alias: string]: string[];
}

/**
 * Shape of the relevant subset of a tsconfig.json file.
 * All fields are optional because the file may be incomplete or malformed.
 */
interface TsConfigJson {
  compilerOptions?: {
    paths?: Record<string, unknown>;
    baseUrl?: unknown;
    extends?: unknown;
  };
  extends?: unknown;
}

/**
 * Read and parse `tsconfig.json` from `projectRoot`, then return the
 * `compilerOptions.paths` object.
 *
 * - Returns an empty object when the file does not exist, cannot be read,
 *   or does not contain a `paths` key.
 * - Silently ignores invalid entries (non-array values, non-string elements).
 * - Does **not** recursively resolve `extends` chains (an `extends` chain
 *   would require resolving node_modules and is out of scope here; callers
 *   that need full resolution should use the TypeScript compiler API).
 *
 * @param projectRoot  Absolute path to the project being analysed.
 */
export function loadTsConfigPaths(projectRoot: string): TsConfigPaths {
  const result: TsConfigPaths = {};

  const tsconfigPath = path.resolve(projectRoot, 'tsconfig.json');

  let raw: string;
  try {
    raw = fs.readFileSync(tsconfigPath, 'utf8');
  } catch {
    // File not found or unreadable — return empty.
    return result;
  }

  // tsconfig.json files are permitted to contain comments and trailing commas
  // (JSONC format).  Strip single-line comments before parsing.
  const stripped = raw
    .replace(/\/\/[^\n]*/g, '')      // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, ''); // multi-line comments

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Invalid JSON — return empty.
    return result;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return result;
  }

  const config = parsed as TsConfigJson;
  const paths = config.compilerOptions?.paths;

  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) {
    return result;
  }

  // Validate and copy each entry.
  for (const [alias, targets] of Object.entries(paths)) {
    if (!alias) continue;

    // Each value must be an array of strings.
    if (!Array.isArray(targets)) continue;

    const validTargets: string[] = [];
    for (const t of targets) {
      if (typeof t === 'string' && t.length > 0) {
        validTargets.push(t);
      }
    }

    if (validTargets.length > 0) {
      result[alias] = validTargets;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Alias resolution
// ---------------------------------------------------------------------------

/**
 * Try to resolve an import source through a set of TypeScript path aliases.
 *
 * Returns the first matching resolved path (with the wildcard substituted),
 * or `null` when no alias matches.
 *
 * The returned string is still a path pattern string (e.g. `'./src/utils'`)
 * and may require further resolution relative to `projectRoot`.
 *
 * @param source      Raw import source string.
 * @param paths       Path alias map from `loadTsConfigPaths`.
 * @param projectRoot Project root for making paths absolute.
 */
export function resolveAlias(
  source: string,
  paths: TsConfigPaths,
  projectRoot: string,
): string | null {
  if (!source || Object.keys(paths).length === 0) return null;

  for (const [alias, targets] of Object.entries(paths)) {
    if (!targets || targets.length === 0) continue;

    let resolved: string | null = null;

    if (alias.endsWith('/*')) {
      // Wildcard alias: '@app/*' matches '@app/utils', '@app/components/Foo', …
      const prefix = alias.slice(0, -2); // strip trailing '/*'
      if (source.startsWith(prefix + '/')) {
        const rest = source.slice(prefix.length + 1); // the '*' part
        const firstTarget = targets[0]!;
        const targetBase = firstTarget.endsWith('/*')
          ? firstTarget.slice(0, -2)
          : firstTarget;
        resolved = targetBase + '/' + rest;
      }
    } else if (alias === source) {
      // Exact alias: '@utils' → './src/utils/index.ts'
      resolved = targets[0] ?? null;
    }

    if (resolved !== null) {
      // Make relative to projectRoot if the target starts with './'.
      if (resolved.startsWith('./') || resolved.startsWith('../')) {
        return path.resolve(projectRoot, resolved);
      }
      return resolved;
    }
  }

  return null;
}
