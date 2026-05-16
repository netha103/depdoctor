/**
 * Fix orchestrator — plans all available fixes from a `ScanResult`, creates a
 * backup, runs the combined import+variable fixer and the dependency
 * uninstaller, then returns a consolidated `FixResult`.
 */

import type { Config, ScanResult, FixResult, FixAction } from '../types.js';
import { createBackup } from './backup.js';
import { fixImportsAndVars } from './combined-fixer.js';
import { fixUnusedDeps } from './dep-fixer.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Fix planning
// ---------------------------------------------------------------------------

function planFixes(scanResult: ScanResult): FixAction[] {
  const actions: FixAction[] = [];

  for (const issue of scanResult.importIssues) {
    if (issue.type === 'unused-import') {
      actions.push({
        type: 'remove-import',
        file: issue.file,
        line: issue.line,
        description: `Remove unused import from "${issue.source}" in ${issue.file}:${issue.line}`,
        confidence: 'high',
        issueRef: issue,
      });
    } else if (issue.type === 'unused-specifier' && issue.specifier !== undefined) {
      actions.push({
        type: 'remove-import',
        file: issue.file,
        line: issue.line,
        description: `Remove unused specifier "${issue.specifier}" from "${issue.source}" in ${issue.file}:${issue.line}`,
        confidence: 'medium',
        issueRef: issue,
      });
    }
  }

  for (const issue of scanResult.dependencyIssues) {
    if (issue.type === 'unused') {
      actions.push({
        type: 'uninstall-dep',
        description: `Uninstall unused production dependency "${issue.name}"`,
        confidence: 'high',
        issueRef: issue,
      });
    } else if (issue.type === 'unused-dev') {
      actions.push({
        type: 'uninstall-dep',
        description: `Uninstall unused dev dependency "${issue.name}" (manual review recommended)`,
        confidence: 'medium',
        issueRef: issue,
      });
    }
  }

  for (const issue of scanResult.variableIssues) {
    actions.push({
      type: 'remove-variable',
      file: issue.file,
      line: issue.line,
      description: `Remove unused variable "${issue.name}" (${issue.kind}) in ${issue.file}:${issue.line}`,
      confidence: 'medium',
      issueRef: issue,
    });
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function applyFixes(
  projectRoot: string,
  scanResult: ScanResult,
  _config: Config,
  dryRun: boolean,
): Promise<FixResult> {
  const allActions = planFixes(scanResult);
  const applied: FixAction[] = [];
  const skipped: FixAction[] = [];
  const errors: string[] = [];
  let backupPath: string | null = null;

  if (allActions.length === 0) {
    logger.info('FixEngine: no fixable issues found.');
    return { applied, skipped, backupPath, errors };
  }

  logger.info(`FixEngine: ${allActions.length} action(s) planned`);

  const importActions  = allActions.filter((a) => a.type === 'remove-import');
  const depActions     = allActions.filter((a) => a.type === 'uninstall-dep');
  const variableActions = allActions.filter((a) => a.type === 'remove-variable');

  // ── Backup ─────────────────────────────────────────────────────────────
  if (!dryRun && (importActions.length > 0 || variableActions.length > 0 || depActions.length > 0)) {
    const filesToBackup = [
      ...new Set([
        ...importActions.map((a) => a.file),
        ...variableActions.map((a) => a.file),
      ].filter((f): f is string => f !== undefined)),
    ];

    try {
      backupPath = await createBackup(projectRoot, filesToBackup);
      logger.success(`FixEngine: backup created at "${backupPath}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`FixEngine: backup failed — aborting fixes: ${msg}`);
      errors.push(`Backup failed: ${msg}`);
      for (const action of [...importActions, ...variableActions, ...depActions]) {
        skipped.push({ ...action, description: `[skipped — backup failed] ${action.description}` });
      }
      return { applied, skipped, backupPath: null, errors };
    }
  }

  // ── Combined import + variable fixes (single pass per file) ────────────
  if (importActions.length > 0 || variableActions.length > 0) {
    const importIssues = scanResult.importIssues.filter((issue) =>
      importActions.some((a) => a.file === issue.file && a.line === issue.line),
    );
    const varIssues = scanResult.variableIssues.filter((issue) =>
      variableActions.some((a) => a.file === issue.file && a.line === issue.line),
    );

    const combinedResults = await fixImportsAndVars(importIssues, varIssues, dryRun);

    for (const result of combinedResults) {
      const fileImportActions  = importActions.filter((a) => a.file === result.file);
      const fileVarActions = variableActions.filter((a) => a.file === result.file);

      for (const action of [...fileImportActions, ...fileVarActions]) {
        if (result.applied) {
          applied.push(action);
        } else {
          skipped.push({
            ...action,
            description: `[skipped${dryRun ? ' — dry run' : ''}] ${action.description}`,
          });
        }
      }

      if (!result.applied && result.reason !== undefined && !dryRun) {
        errors.push(`Fix failed for "${result.file}": ${result.reason}`);
      }
    }
  }

  // ── Dependency uninstalls ──────────────────────────────────────────────
  if (depActions.length > 0) {
    const depResults = await fixUnusedDeps(projectRoot, scanResult.dependencyIssues, dryRun);

    for (const result of depResults) {
      const action = depActions.find((a) => {
        if ('name' in a.issueRef) return a.issueRef.name === result.package;
        return false;
      });
      if (action === undefined) continue;

      if (result.uninstalled) {
        applied.push(action);
      } else {
        skipped.push({
          ...action,
          description: `[skipped${dryRun ? ' — dry run' : ''}] ${action.description}`,
        });
      }

      if (!result.uninstalled && result.reason !== undefined && !dryRun) {
        errors.push(`Dep fix failed for "${result.package}": ${result.reason}`);
      }
    }
  }

  logger.info(
    `FixEngine: ${applied.length} action(s) applied, ` +
      `${skipped.length} skipped, ` +
      `${errors.length} error(s)`,
  );

  return { applied, skipped, backupPath, errors };
}
