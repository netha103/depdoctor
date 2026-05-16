/**
 * Dependency uninstaller — removes unused npm/yarn/pnpm packages from the
 * project by running the appropriate package manager's uninstall command.
 *
 * Only 'unused' (production dependency) issues are acted upon by default.
 * Dev-dependency issues are reported but not uninstalled automatically because
 * dev-dep detection has a higher false-positive rate.
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { DependencyIssue } from '../types.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DepFixResult {
  package: string;
  uninstalled: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect the package manager in use by checking for known lockfiles.
 * Falls back to npm when none are found.
 */
function detectPackageManager(projectRoot: string): 'npm' | 'yarn' | 'pnpm' {
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * Build the uninstall command for a given package manager and package name.
 */
function buildUninstallCommand(
  pm: 'npm' | 'yarn' | 'pnpm',
  packageName: string,
  isDev: boolean,
): string {
  switch (pm) {
    case 'yarn':
      return `yarn remove ${packageName}`;
    case 'pnpm':
      return isDev
        ? `pnpm remove --save-dev ${packageName}`
        : `pnpm remove ${packageName}`;
    case 'npm':
    default:
      return isDev
        ? `npm uninstall --save-dev ${packageName}`
        : `npm uninstall ${packageName}`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Uninstall unused dependencies found in `depIssues`.
 *
 * Rules:
 * - Only `'unused'` type issues with `'warning'` severity are acted upon
 *   (production dependencies that are provably not imported anywhere).
 * - `'unused-dev'` packages (devDependencies) are listed but not uninstalled
 *   automatically to avoid accidentally removing tooling packages.
 * - When `dryRun` is true, the commands that would be executed are logged but
 *   not run.
 *
 * @returns One `DepFixResult` per package that was considered for removal.
 */
export async function fixUnusedDeps(
  projectRoot: string,
  depIssues: DependencyIssue[],
  dryRun: boolean,
): Promise<DepFixResult[]> {
  const results: DepFixResult[] = [];

  if (depIssues.length === 0) {
    return results;
  }

  const resolvedRoot = path.resolve(projectRoot);
  const pm = detectPackageManager(resolvedRoot);
  logger.debug(`DepFixer: detected package manager "${pm}" in "${resolvedRoot}"`);

  // Filter to actionable issues: production unused deps only.
  const actionable = depIssues.filter(
    (issue) => issue.type === 'unused' && issue.severity === 'warning',
  );

  // Report skipped dev-dep issues informatively.
  const devDeps = depIssues.filter((issue) => issue.type === 'unused-dev');
  for (const issue of devDeps) {
    logger.info(
      `DepFixer: skipping dev dependency "${issue.name}" — remove manually if not needed`,
    );
    results.push({
      package: issue.name,
      uninstalled: false,
      reason: 'Dev dependency — skipped to avoid removing tooling packages',
    });
  }

  // Report other skipped issue types.
  const others = depIssues.filter(
    (issue) => issue.type !== 'unused' && issue.type !== 'unused-dev',
  );
  for (const issue of others) {
    results.push({
      package: issue.name,
      uninstalled: false,
      reason: `Issue type "${issue.type}" is not handled by the auto-fixer`,
    });
  }

  // Process actionable packages.
  for (const issue of actionable) {
    const isDev = false; // actionable filter guarantees type === 'unused'
    const command = buildUninstallCommand(pm, issue.name, isDev);

    if (dryRun) {
      logger.info(`DepFixer (dry-run): would run: ${command}`);
      results.push({
        package: issue.name,
        uninstalled: false,
        reason: `Dry run — command not executed: ${command}`,
      });
      continue;
    }

    logger.info(`DepFixer: running: ${command}`);

    try {
      execSync(command, {
        cwd: resolvedRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000, // 2 minutes
      });
      logger.success(`DepFixer: uninstalled "${issue.name}"`);
      results.push({ package: issue.name, uninstalled: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`DepFixer: failed to uninstall "${issue.name}": ${msg}`);
      results.push({
        package: issue.name,
        uninstalled: false,
        reason: `Uninstall command failed: ${msg}`,
      });
    }
  }

  return results;
}
