import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config, DependencyIssue, ParsedFile } from '../../types.js';
import { extractPackageName } from '../../core/resolver/import-resolver.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Packages that are consumed via config files / plugin discovery rather than
 * explicit `import` statements.  Flagging them as "unused" would be a false
 * positive in the vast majority of projects.
 */
const BUILD_TOOLS = new Set([
  'typescript',
  'eslint',
  'prettier',
  'webpack',
  'webpack-cli',
  'webpack-dev-server',
  'rollup',
  'vite',
  'esbuild',
  'babel',
  '@babel/core',
  '@babel/cli',
  'jest',
  'vitest',
  'mocha',
  'chai',
  'sinon',
  'ts-node',
  'tsx',
  'nodemon',
  'ts-jest',
  'husky',
  'lint-staged',
  'rimraf',
  'cross-env',
  'dotenv-cli',
  'concurrently',
  'wait-on',
  'react-scripts',
  'next',
  'nuxt',
  'gatsby',
  '@angular/cli',
  '@vue/cli-service',
  'parcel',
  'snowpack',
  'turbo',
  'lerna',
  'nx',
  'changesets',
  '@changesets/cli',
  'release-it',
  'semantic-release',
  'standard-version',
  'commitlint',
  '@commitlint/cli',
  '@commitlint/config-conventional',
]);

/**
 * Prefix patterns for packages that are used by the toolchain rather than
 * explicitly imported (e.g. Babel/ESLint plugin ecosystems, @types/* stubs).
 */
const INDIRECT_PREFIXES: readonly string[] = [
  '@types/',
  'eslint-',
  'babel-plugin-',
  'babel-preset-',
  '@babel/plugin-',
  '@babel/preset-',
  'webpack-',
  'rollup-plugin-',
  'vite-plugin-',
  'postcss-',
  'stylelint-',
  'jest-',
  'ts-',
  '@jest/',
  '@typescript-eslint/',
  '@eslint/',
  'eslint_d',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readPackageJson(projectRoot: string): PackageJson | null {
  const pkgPath = path.join(projectRoot, 'package.json');
  try {
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * Returns true when a package name should be excluded from unused-dep checks
 * because it is a build / toolchain package consumed implicitly.
 */
function isIndirectPackage(name: string): boolean {
  if (BUILD_TOOLS.has(name)) return true;
  for (const prefix of INDIRECT_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Collect every npm package name referenced by any import across all parsed files.
 */
function collectImportedPackages(parsedFiles: ParsedFile[]): Set<string> {
  const packages = new Set<string>();
  for (const file of parsedFiles) {
    for (const imp of file.imports) {
      const pkgName = extractPackageName(imp.source);
      if (pkgName !== null) {
        packages.add(pkgName);
      }
    }
  }
  return packages;
}

/**
 * Returns true when a package name matches any of the entries in the ignore
 * lists (exact match or glob-style `*` prefix/suffix wildcard).
 */
function isIgnored(name: string, ignoreList: readonly string[]): boolean {
  for (const pattern of ignoreList) {
    if (pattern === name) return true;
    if (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))) return true;
    if (pattern.startsWith('*') && name.endsWith(pattern.slice(1))) return true;
  }
  return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyse `package.json` dependencies against the set of packages actually
 * imported in the parsed source files and return a list of `DependencyIssue`
 * records for any that appear unused.
 *
 * Conservative by design — packages consumed indirectly (build tools, type
 * stubs, ESLint plugins, …) are never flagged.
 */
export function checkDependencies(
  projectRoot: string,
  parsedFiles: ParsedFile[],
  config: Config,
): DependencyIssue[] {
  const pkg = readPackageJson(projectRoot);
  if (pkg === null) return [];

  const importedPackages = collectImportedPackages(parsedFiles);
  const peerDeps = new Set(Object.keys(pkg.peerDependencies ?? {}));
  const optionalDeps = new Set(Object.keys(pkg.optionalDependencies ?? {}));

  const combinedIgnore: string[] = [
    ...config.ignoreDependencies,
    ...config.ignorePackages,
  ];

  const issues: DependencyIssue[] = [];

  // ── Check production dependencies ─────────────────────────────────────────
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (peerDeps.has(name)) continue;
    if (optionalDeps.has(name)) continue;
    if (isIndirectPackage(name)) continue;
    if (isIgnored(name, combinedIgnore)) continue;
    if (importedPackages.has(name)) continue;

    issues.push({
      type: 'unused',
      name,
      severity: 'warning',
      description: `"${name}" is listed in dependencies but is not imported in any source file.`,
    });
  }

  // ── Check dev dependencies (only when opted-in) ───────────────────────────
  if (config.includeDevDependencies) {
    for (const name of Object.keys(pkg.devDependencies ?? {})) {
      if (peerDeps.has(name)) continue;
      if (optionalDeps.has(name)) continue;
      if (isIndirectPackage(name)) continue;
      if (isIgnored(name, combinedIgnore)) continue;
      if (importedPackages.has(name)) continue;

      issues.push({
        type: 'unused-dev',
        name,
        severity: 'info',
        description: `"${name}" is listed in devDependencies but is not imported in any source file.`,
      });
    }
  }

  return issues;
}
