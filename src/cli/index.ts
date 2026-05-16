/**
 * depdoctor CLI entry point.
 *
 * Commands:
 *   scan      — Scan a project for dependency, import, variable and security issues
 *   fix       — Fix unused imports and remove unused dependencies
 *   security  — Run a standalone security audit
 *   report    — Generate a full project-health report (terminal / JSON / Markdown)
 *   rollback  — Restore files from the latest backup
 */

import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../config/loader.js';
import { analyzeProject } from '../core/analyzer/project-analyzer.js';
import { applyFixes } from '../fixers/fix-engine.js';
import { restoreLatestBackup } from '../fixers/backup.js';
import { formatTerminal, formatJson, formatMarkdown, generatePdfReport } from '../formatters/index.js';
import { logger } from '../utils/logger.js';
import type { Config, ScanResult } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an absolute project root from a CLI --cwd option.
 */
function resolveProjectRoot(cwd: string): string {
  return path.resolve(cwd);
}

/**
 * Exit with code 1 if any critical / high severity issues are present.
 * Otherwise exit with code 0.
 */
function exitWithCode(scanResult: ScanResult): never {
  const hasErrors = [
    ...scanResult.dependencyIssues,
    ...scanResult.importIssues,
    ...scanResult.variableIssues,
  ].some((i) => i.severity === 'error');

  const hasCriticalSecurity = scanResult.securityIssues.some(
    (i) => i.severity === 'critical' || i.severity === 'high',
  );

  process.exit(hasErrors || hasCriticalSecurity ? 1 : 0);
}

/**
 * Write `content` to `outputFile`, creating parent directories as needed.
 */
function writeOutputFile(outputFile: string, content: string): void {
  const dir = path.dirname(outputFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputFile, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Program setup
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('depdoctor')
  .description('Production-grade developer dependency and code health CLI')
  .version('0.1.6');

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

program
  .command('scan')
  .description('Scan project for dependency, import, variable and security issues')
  .option('--json', 'Output results as JSON')
  .option('--pdf', 'Generate PDF report')
  .option('--pdf-output <file>', 'PDF output path (default: .depdoctor-report.pdf)')
  .option('--no-security', 'Skip security checks')
  .option('--debug', 'Enable debug logging')
  .option('--cwd <path>', 'Project root directory', process.cwd())
  .action(async (options: {
    json?: boolean;
    pdf?: boolean;
    pdfOutput?: string;
    security: boolean;
    debug?: boolean;
    cwd: string;
  }) => {
    if (options.debug) logger.enableDebug();

    const projectRoot = resolveProjectRoot(options.cwd);
    logger.debug(`scan: project root = "${projectRoot}"`);

    let config: Config;
    try {
      config = loadConfig(projectRoot);
    } catch (err) {
      logger.error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // CLI flags override config file
    if (!options.security) {
      config = { ...config, security: false };
    }

    let scanResult: ScanResult;
    try {
      scanResult = await analyzeProject(projectRoot, config);
    } catch (err) {
      logger.error(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    if (options.pdf === true) {
      const pdfPath = options.pdfOutput ?? path.join(projectRoot, '.depdoctor-report.pdf');
      const spinner = ora('Generating PDF report…').start();
      try {
        await generatePdfReport(scanResult, pdfPath);
        spinner.succeed(`PDF report written to "${pdfPath}"`);
      } catch (err) {
        spinner.fail('PDF generation failed');
        logger.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    } else if (options.json) {
      process.stdout.write(formatJson(scanResult) + '\n');
    } else {
      process.stdout.write(formatTerminal(scanResult) + '\n');
    }

    exitWithCode(scanResult);
  });

// ---------------------------------------------------------------------------
// fix
// ---------------------------------------------------------------------------

program
  .command('fix')
  .description('Fix unused imports and remove unused dependencies')
  .option('--dry-run', 'Preview fixes without modifying files')
  .option('--yes', 'Skip confirmation prompt')
  .option('--pdf', 'Generate PDF report after fix')
  .option('--pdf-output <file>', 'PDF output path (default: .depdoctor-fix-report.pdf)')
  .option('--debug', 'Enable debug logging')
  .option('--cwd <path>', 'Project root directory', process.cwd())
  .action(async (options: {
    dryRun?: boolean;
    yes?: boolean;
    pdf?: boolean;
    pdfOutput?: string;
    debug?: boolean;
    cwd: string;
  }) => {
    if (options.debug) logger.enableDebug();

    const projectRoot = resolveProjectRoot(options.cwd);
    const dryRun = options.dryRun === true;

    logger.debug(`fix: project root = "${projectRoot}", dryRun = ${String(dryRun)}`);

    // ── Load config ──────────────────────────────────────────────────────
    let config: Config;
    try {
      config = loadConfig(projectRoot);
    } catch (err) {
      logger.error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // ── Scan ─────────────────────────────────────────────────────────────
    logger.info(chalk.bold('Step 1/2: Scanning project…'));
    let scanResult: ScanResult;
    try {
      scanResult = await analyzeProject(projectRoot, config);
    } catch (err) {
      logger.error(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const totalFixable =
      scanResult.importIssues.length +
      scanResult.dependencyIssues.length +
      scanResult.variableIssues.length;

    if (totalFixable === 0) {
      logger.success('No fixable issues found.');
      process.exit(0);
    }

    // ── Show plan ─────────────────────────────────────────────────────────
    logger.blank();
    logger.section('Fix plan');
    if (scanResult.importIssues.length > 0) {
      logger.print(
        chalk.yellow(`  • ${scanResult.importIssues.length} unused import(s) to remove`),
      );
    }
    if (scanResult.dependencyIssues.filter((d) => d.type === 'unused').length > 0) {
      logger.print(
        chalk.yellow(
          `  • ${scanResult.dependencyIssues.filter((d) => d.type === 'unused').length} unused production dep(s) to uninstall`,
        ),
      );
    }
    if (scanResult.dependencyIssues.filter((d) => d.type === 'unused-dev').length > 0) {
      logger.print(
        chalk.gray(
          `  • ${scanResult.dependencyIssues.filter((d) => d.type === 'unused-dev').length} unused dev dep(s) (skipped — manual review)`,
        ),
      );
    }
    if (scanResult.variableIssues.length > 0) {
      logger.print(
        chalk.yellow(`  • ${scanResult.variableIssues.length} unused variable(s) to remove`),
      );
    }
    logger.blank();

    if (dryRun) {
      logger.info(chalk.cyan('Dry-run mode — no files will be modified.'));
    }

    // ── Confirmation ─────────────────────────────────────────────────────
    if (!dryRun && options.yes !== true) {
      // Inline readline prompt (avoids importing readline in a way that
      // affects the test harness).
      const readline = await import('node:readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const confirmed = await new Promise<boolean>((resolve) => {
        rl.question(
          chalk.bold(`Apply ${totalFixable} fix(es)? `) + chalk.gray('[y/N] '),
          (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === 'y');
          },
        );
      });

      if (!confirmed) {
        logger.info('Aborted.');
        process.exit(0);
      }
    }

    // ── Apply fixes ───────────────────────────────────────────────────────
    logger.info(chalk.bold('Step 2/2: Applying fixes…'));
    const spinner = ora('Fixing…').start();

    let fixResult;
    try {
      fixResult = await applyFixes(projectRoot, scanResult, config, dryRun);
    } catch (err) {
      spinner.fail('Fix step failed');
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (fixResult.errors.length > 0) {
      spinner.warn(`Fixes completed with ${fixResult.errors.length} error(s)`);
      for (const e of fixResult.errors) logger.error(e);
    } else {
      spinner.succeed(
        `Fixes complete — ${fixResult.applied.length} applied, ${fixResult.skipped.length} skipped`,
      );
    }

    if (fixResult.backupPath !== null) {
      logger.info(`Backup created at: ${chalk.blue(fixResult.backupPath)}`);
      logger.info('Run `depdoctor rollback` to undo these changes.');
    }

    if (options.pdf === true) {
      const pdfPath = options.pdfOutput ?? path.join(projectRoot, '.depdoctor-fix-report.pdf');
      const pdfSpinner = ora('Generating PDF fix report…').start();
      try {
        await generatePdfReport(scanResult, pdfPath, fixResult);
        pdfSpinner.succeed(`PDF fix report written to "${pdfPath}"`);
      } catch (err) {
        pdfSpinner.fail('PDF generation failed');
        logger.error(err instanceof Error ? err.message : String(err));
      }
    }

    process.exit(fixResult.errors.length > 0 ? 1 : 0);
  });

// ---------------------------------------------------------------------------
// security
// ---------------------------------------------------------------------------

program
  .command('security')
  .description('Run security audit on project dependencies')
  .option('--json', 'Output results as JSON')
  .option('--debug', 'Enable debug logging')
  .option('--cwd <path>', 'Project root directory', process.cwd())
  .action(async (options: {
    json?: boolean;
    debug?: boolean;
    cwd: string;
  }) => {
    if (options.debug) logger.enableDebug();

    const projectRoot = resolveProjectRoot(options.cwd);
    logger.debug(`security: project root = "${projectRoot}"`);

    let config: Config;
    try {
      config = loadConfig(projectRoot);
    } catch (err) {
      logger.error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // Force security on.
    config = { ...config, security: true };

    const spinner = ora('Running security audit…').start();
    let scanResult: ScanResult;
    try {
      scanResult = await analyzeProject(projectRoot, config);
      spinner.succeed('Security audit complete');
    } catch (err) {
      spinner.fail('Security audit failed');
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // Build a synthetic result containing only security issues.
    const securityOnlyResult: ScanResult = {
      ...scanResult,
      dependencyIssues: [],
      importIssues: [],
      variableIssues: [],
      envIssues: [],
    };

    if (options.json) {
      process.stdout.write(formatJson(securityOnlyResult) + '\n');
    } else {
      process.stdout.write(formatTerminal(securityOnlyResult) + '\n');
    }

    const hasCritical = scanResult.securityIssues.some(
      (i) => i.severity === 'critical' || i.severity === 'high',
    );
    process.exit(hasCritical ? 1 : 0);
  });

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

program
  .command('report')
  .description('Generate a detailed project health report')
  .option('--markdown', 'Generate Markdown report')
  .option('--json', 'Generate JSON report')
  .option('--pdf', 'Generate PDF report')
  .option('--output <file>', 'Output file path')
  .option('--debug', 'Enable debug logging')
  .option('--cwd <path>', 'Project root directory', process.cwd())
  .action(async (options: {
    markdown?: boolean;
    json?: boolean;
    pdf?: boolean;
    output?: string;
    debug?: boolean;
    cwd: string;
  }) => {
    if (options.debug) logger.enableDebug();

    const projectRoot = resolveProjectRoot(options.cwd);
    logger.debug(`report: project root = "${projectRoot}"`);

    let config: Config;
    try {
      config = loadConfig(projectRoot);
    } catch (err) {
      logger.error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // Determine output format.
    let format: 'terminal' | 'json' | 'markdown' | 'pdf' = 'terminal';
    if (options.pdf) format = 'pdf';
    else if (options.json) format = 'json';
    else if (options.markdown) format = 'markdown';
    else if (config.reportFormat !== undefined) format = config.reportFormat;

    const spinner = ora('Scanning project for report…').start();
    let scanResult: ScanResult;
    try {
      scanResult = await analyzeProject(projectRoot, config);
      spinner.succeed('Scan complete');
    } catch (err) {
      spinner.fail('Scan failed');
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (format === 'pdf') {
      const pdfPath =
        options.output ??
        config.outputFile ??
        path.join(projectRoot, '.depdoctor-report.pdf');
      const pdfSpinner = ora('Generating PDF report…').start();
      try {
        await generatePdfReport(scanResult, pdfPath);
        pdfSpinner.succeed(`PDF report written to "${pdfPath}"`);
      } catch (err) {
        pdfSpinner.fail('PDF generation failed');
        logger.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      process.exit(0);
    }

    // Format text output.
    let output: string;
    switch (format) {
      case 'json':
        output = formatJson(scanResult);
        break;
      case 'markdown':
        output = formatMarkdown(scanResult);
        break;
      default:
        output = formatTerminal(scanResult);
    }

    // Determine output destination.
    // --markdown defaults to .depdoctor-report.md per spec; --json defaults to stdout.
    const defaultOutputFile =
      options.output ??
      config.outputFile ??
      (options.markdown === true ? path.join(projectRoot, '.depdoctor-report.md') : undefined);

    if (defaultOutputFile !== undefined) {
      try {
        writeOutputFile(defaultOutputFile, output);
        logger.success(`Report written to "${defaultOutputFile}"`);
      } catch (err) {
        logger.error(
          `Failed to write report: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    } else {
      process.stdout.write(output + '\n');
    }

    process.exit(0);
  });

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

program
  .command('rollback')
  .description('Restore files from the latest backup')
  .option('--debug', 'Enable debug logging')
  .option('--cwd <path>', 'Project root directory', process.cwd())
  .action(async (options: {
    debug?: boolean;
    cwd: string;
  }) => {
    if (options.debug) logger.enableDebug();

    const projectRoot = resolveProjectRoot(options.cwd);
    logger.debug(`rollback: project root = "${projectRoot}"`);

    const spinner = ora('Restoring from latest backup…').start();

    try {
      await restoreLatestBackup(projectRoot);
      spinner.succeed('Rollback complete — files restored from latest backup');
    } catch (err) {
      spinner.fail('Rollback failed');
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    process.exit(0);
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse();
