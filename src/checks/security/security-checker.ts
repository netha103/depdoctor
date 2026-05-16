import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Config,
  SecurityIssue,
  SecuritySeverity,
  NpmAuditResult,
  NpmAuditVulnerability,
} from '../../types.js';
import { logger } from '../../utils/logger.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Known (legit package, typosquat) pairs.
 * When a project depends on the right-hand name, it is flagged as a likely
 * typosquat of the left-hand package.
 */
const KNOWN_TYPOSQUATS: Array<[string, string]> = [
  ['lodash', 'lodas'],
  ['lodash', 'loadsh'],
  ['lodash', 'lodahs'],
  ['react', 'reacts'],
  ['react', 'rreact'],
  ['express', 'expres'],
  ['express', 'expresss'],
  ['axios', 'axois'],
  ['axios', 'axioss'],
  ['moment', 'momment'],
  ['moment', 'momentjs'],
  ['chalk', 'chalks'],
  ['chalk', 'chak'],
  ['webpack', 'webpak'],
  ['webpack', 'webpackk'],
  ['commander', 'commnader'],
  ['typescript', 'typescirpt'],
  ['typescript', 'tyepscript'],
  ['prettier', 'pretteir'],
  ['eslint', 'esslint'],
  ['semver', 'semmver'],
  ['glob', 'glog'],
  ['ora', 'oraa'],
];

/**
 * Shell-injection / supply-chain attack patterns that are suspicious in
 * `scripts` or `postinstall` entries.
 */
const DANGEROUS_SCRIPT_PATTERNS: RegExp[] = [
  /curl\s+.+\|\s*(bash|sh)/,
  /wget\s+.+\|\s*(bash|sh)/,
  /\beval\s*\(/,
  /base64\s+--decode/,
  /base64\s+-d\b/,
  /python\s+-c\b/,
  /python3\s+-c\b/,
  /\bexec\s*\(/,
  /\bspawn\s*\(/,
  // node -e is dangerous only when used to fetch/run remote code.
  // Safe patterns like core-js's `node -e "try{require('./postinstall')}catch(e){}"` are excluded.
  /node\s+-e\s+["'](?!try\s*\{?\s*require\s*\(['"]\.\/)/,
  /require\s*\(\s*['"]child_process['"]\s*\)/,
  /\/dev\/tcp\//,
  /\bnc\s+-[a-z]*e\b/,
];

// Packages known to use safe lifecycle scripts that match generic patterns.
const SAFE_POSTINSTALL_PACKAGES = new Set([
  'core-js',
  'core-js-pure',
  'core-js-compat',
  'core-js-builder',
]);

// ─── Types ───────────────────────────────────────────────────────────────────

interface PackageJsonScripts {
  [key: string]: string | undefined;
}

interface MinimalPackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: PackageJsonScripts;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readPackageJson(dir: string): MinimalPackageJson | null {
  const pkgPath = path.join(dir, 'package.json');
  try {
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    return JSON.parse(raw) as MinimalPackageJson;
  } catch {
    return null;
  }
}

/**
 * Map npm audit severity strings to our internal SecuritySeverity enum values.
 * Unknown strings default to 'info'.
 */
function mapNpmSeverity(raw: string): SecuritySeverity {
  switch (raw.toLowerCase()) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'moderate': return 'moderate';
    case 'low': return 'low';
    default: return 'info';
  }
}

/**
 * Extract a human-readable list of advisory "via" sources from a vulnerability
 * record.  `via` entries can be either plain strings (advisory IDs / names) or
 * nested advisory objects.
 */
function extractVia(vuln: NpmAuditVulnerability): string[] {
  return vuln.via
    .map((v) => (typeof v === 'string' ? v : v.name))
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * Build a human-readable fix recommendation from the `fixAvailable` field.
 */
function buildFixRecommendation(vuln: NpmAuditVulnerability): string | undefined {
  if (vuln.fixAvailable === false) return 'No fix is currently available.';
  if (vuln.fixAvailable === true) return 'Run `npm audit fix` to apply the available fix.';
  if (typeof vuln.fixAvailable === 'object') {
    const { name, version, isSemVerMajor } = vuln.fixAvailable;
    if (isSemVerMajor) {
      return `Breaking fix available: upgrade to ${name}@${version} (major version bump required).`;
    }
    return `Run \`npm audit fix\` to upgrade to ${name}@${version}.`;
  }
  return undefined;
}

/**
 * Check a single script string against all dangerous patterns.
 * Returns the matching pattern description if dangerous, otherwise null.
 */
function findDangerousPattern(script: string): RegExp | null {
  for (const re of DANGEROUS_SCRIPT_PATTERNS) {
    if (re.test(script)) return re;
  }
  return null;
}

// ─── npm audit ───────────────────────────────────────────────────────────────

async function runNpmAudit(projectRoot: string): Promise<SecurityIssue[]> {
  let stdout: string;
  try {
    stdout = execSync('npm audit --json', {
      cwd: projectRoot,
      // npm audit exits with code 1 when vulnerabilities exist; we still want stdout.
      stdio: ['ignore', 'pipe', 'pipe'],
      // Give npm up to 60 s to resolve the registry.
      timeout: 60_000,
    }).toString('utf-8');
  } catch (err: unknown) {
    // execSync throws when the process exits non-zero.
    // The JSON output is still attached to `stdout` on the error object.
    const spawnError = err as { stdout?: Buffer | string; message?: string };
    if (spawnError.stdout) {
      stdout = Buffer.isBuffer(spawnError.stdout)
        ? spawnError.stdout.toString('utf-8')
        : spawnError.stdout;
    } else {
      logger.warn(`npm audit failed to run: ${spawnError.message ?? 'unknown error'}`);
      return [];
    }
  }

  let auditResult: NpmAuditResult;
  try {
    auditResult = JSON.parse(stdout) as NpmAuditResult;
  } catch {
    logger.warn('Could not parse npm audit JSON output.');
    return [];
  }

  const vulnerabilities = auditResult.vulnerabilities ?? {};
  const issues: SecurityIssue[] = [];

  for (const [pkgName, vuln] of Object.entries(vulnerabilities)) {
    const severity = mapNpmSeverity(vuln.severity);
    const via = extractVia(vuln);
    const recommendation = buildFixRecommendation(vuln);

    const description = via.length > 0
      ? `Vulnerability in "${pkgName}" via: ${via.join(', ')}.`
      : `Vulnerability found in "${pkgName}" (severity: ${vuln.severity}).`;

    const issue: SecurityIssue = {
      type: 'vulnerability',
      package: pkgName,
      severity,
      description,
    };
    if (via.length > 0) issue.via = via;
    if (recommendation !== undefined) issue.recommendation = recommendation;

    issues.push(issue);
  }

  return issues;
}

// ─── Dangerous scripts (package.json) ────────────────────────────────────────

function checkDangerousScripts(projectRoot: string): SecurityIssue[] {
  const pkg = readPackageJson(projectRoot);
  if (pkg === null || pkg.scripts === undefined) return [];

  const issues: SecurityIssue[] = [];

  for (const [scriptName, scriptValue] of Object.entries(pkg.scripts)) {
    if (scriptValue === undefined) continue;

    const match = findDangerousPattern(scriptValue);
    if (match !== null) {
      issues.push({
        type: 'dangerous-script',
        package: pkg.name ?? '(root)',
        severity: 'high',
        description: `Script "${scriptName}" contains a potentially dangerous shell pattern: \`${scriptValue.slice(0, 120)}\``,
        recommendation: 'Review this script carefully before running it. Avoid piping remote content directly into a shell.',
      });
    }
  }

  return issues;
}

// ─── Dangerous postinstall scripts (node_modules) ────────────────────────────

function checkPostinstallScripts(projectRoot: string): SecurityIssue[] {
  const nodeModulesDir = path.join(projectRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) return [];

  const issues: SecurityIssue[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(nodeModulesDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    // Handle scoped packages (@scope/name) — one extra level deep.
    if (entry.startsWith('@')) {
      const scopeDir = path.join(nodeModulesDir, entry);
      let scopedEntries: string[];
      try {
        scopedEntries = fs.readdirSync(scopeDir);
      } catch {
        continue;
      }
      for (const scopedEntry of scopedEntries) {
        const pkgDir = path.join(scopeDir, scopedEntry);
        checkPackageDir(`${entry}/${scopedEntry}`, pkgDir, issues);
      }
      continue;
    }

    // Skip hidden / meta entries.
    if (entry.startsWith('.')) continue;

    const pkgDir = path.join(nodeModulesDir, entry);
    checkPackageDir(entry, pkgDir, issues);
  }

  return issues;
}

/**
 * Read the package.json for a single node_modules package and check its
 * lifecycle scripts for dangerous patterns.
 */
function checkPackageDir(
  pkgName: string,
  pkgDir: string,
  issues: SecurityIssue[],
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(pkgDir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;

  const pkg = readPackageJson(pkgDir);
  if (pkg === null || pkg.scripts === undefined) return;

  // Skip packages with known-safe postinstall scripts.
  if (SAFE_POSTINSTALL_PACKAGES.has(pkgName)) return;

  // Only lifecycle hooks that run automatically are interesting.
  const lifecycleHooks = ['install', 'postinstall', 'preinstall', 'prepare'];

  for (const hook of lifecycleHooks) {
    const scriptValue = pkg.scripts[hook];
    if (scriptValue === undefined) continue;

    const match = findDangerousPattern(scriptValue);
    if (match !== null) {
      issues.push({
        type: 'dangerous-script',
        package: pkgName,
        severity: 'high',
        description: `Package "${pkgName}" has a suspicious "${hook}" script: \`${scriptValue.slice(0, 120)}\``,
        recommendation: `Audit the package "${pkgName}" before installing. Consider removing it or pinning to a safe version.`,
      });
    }
  }
}

// ─── Typosquat detection ─────────────────────────────────────────────────────

function checkTyposquats(projectRoot: string): SecurityIssue[] {
  const pkg = readPackageJson(projectRoot);
  if (pkg === null) return [];

  const allDeps = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);

  const issues: SecurityIssue[] = [];

  for (const [legit, typosquat] of KNOWN_TYPOSQUATS) {
    if (allDeps.has(typosquat)) {
      issues.push({
        type: 'typosquat',
        package: typosquat,
        severity: 'high',
        description: `"${typosquat}" looks like a typosquat of the popular package "${legit}". This may be a supply-chain attack.`,
        recommendation: `If you intended to install "${legit}", remove "${typosquat}" and install the correct package. Otherwise verify that "${typosquat}" is intentional.`,
      });
    }
  }

  return issues;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run all security checks and return a combined list of `SecurityIssue`
 * records.
 *
 * Checks performed (when `config.security` is true):
 *  1. npm audit — known CVE vulnerabilities via the npm advisory registry.
 *  2. package.json scripts — shell patterns characteristic of malicious code.
 *  3. node_modules postinstall scripts — same patterns in dependency lifecycle hooks.
 *  4. Typosquat detection — known (legit, typosquat) package name pairs.
 */
export async function checkSecurity(
  projectRoot: string,
  config: Config,
): Promise<SecurityIssue[]> {
  if (!config.security) return [];

  const issues: SecurityIssue[] = [];

  const auditIssues = await runNpmAudit(projectRoot);
  issues.push(...auditIssues);

  const scriptIssues = checkDangerousScripts(projectRoot);
  issues.push(...scriptIssues);

  const postinstallIssues = checkPostinstallScripts(projectRoot);
  issues.push(...postinstallIssues);

  const typosquatIssues = checkTyposquats(projectRoot);
  issues.push(...typosquatIssues);

  return issues;
}
