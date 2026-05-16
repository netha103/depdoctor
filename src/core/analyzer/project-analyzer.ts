/**
 * Project analyzer — central orchestrator that wires together the file scanner,
 * AST parser, and all check modules, then assembles a `ScanResult`.
 *
 * Design principles:
 * - Never crash: all per-file and per-check errors are caught and surfaced in
 *   `ScanResult.errors` rather than propagating to the caller.
 * - Show progress: ora spinners communicate each phase to the terminal so the
 *   user knows the tool is working on large projects.
 * - Parallelize where safe: independent checks (imports, variables, security,
 *   env) are run concurrently with `Promise.all`.
 */

import * as path from 'node:path';
import ora from 'ora';
import type { Config, ParsedFile, ScanError, ScanResult } from '../../types.js';
import { scanFiles } from '../scanner/file-scanner.js';
import { parseFile } from '../parser/ast-parser.js';
import { checkDependencies } from '../../checks/dependency/dep-checker.js';
import { checkImports } from '../../checks/imports/import-checker.js';
import { checkVariables } from '../../checks/variables/var-checker.js';
import { checkSecurity } from '../../checks/security/security-checker.js';
import { checkEnv } from '../../checks/env/env-checker.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap any synchronous check call so that a thrown exception becomes a
 * `ScanError` rather than crashing the whole analysis.
 */
function safeSync<T>(
  phase: ScanError['phase'],
  label: string,
  fn: () => T,
  errors: ScanError[],
  fallback: T,
): T {
  try {
    return fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Analyzer: ${label} check failed — ${message}`);
    errors.push({ file: label, message, phase });
    return fallback;
  }
}

/**
 * Wrap any async check call so that a rejected promise becomes a `ScanError`.
 */
async function safeAsync<T>(
  phase: ScanError['phase'],
  label: string,
  fn: () => Promise<T>,
  errors: ScanError[],
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Analyzer: ${label} check failed — ${message}`);
    errors.push({ file: label, message, phase });
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse `projectRoot` end-to-end and return a `ScanResult`.
 *
 * Phases:
 *  1. File scanning   — discover all JS/TS source files.
 *  2. AST parsing     — build `ParsedFile` objects for every source file.
 *  3. Checks          — dependency, import, variable, security, env analysis.
 *  4. Assembly        — combine all results into a `ScanResult`.
 */
export async function analyzeProject(
  projectRoot: string,
  config: Config,
): Promise<ScanResult> {
  const start = Date.now();
  const resolvedRoot = path.resolve(projectRoot);
  const errors: ScanError[] = [];

  // ── Phase 1: File scanning ──────────────────────────────────────────────────
  const scanSpinner = ora('Scanning files…').start();
  let scannerResult: Awaited<ReturnType<typeof scanFiles>>;

  try {
    scannerResult = await scanFiles(resolvedRoot, config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    scanSpinner.fail(`File scan failed: ${message}`);
    errors.push({ file: resolvedRoot, message, phase: 'scan' });
    return {
      projectRoot: resolvedRoot,
      filesScanned: 0,
      dependencyIssues: [],
      importIssues: [],
      variableIssues: [],
      securityIssues: [],
      envIssues: [],
      errors,
      durationMs: Date.now() - start,
    };
  }

  // Merge scan-phase errors (e.g. symlinks, over-size files) into our list.
  errors.push(...scannerResult.errors);

  const { files } = scannerResult;
  scanSpinner.succeed(
    `Scanned ${scannerResult.totalDiscovered} paths — ${files.length} file(s) accepted`,
  );
  logger.debug(
    `Analyzer: scanner accepted ${files.length} file(s) out of ${scannerResult.totalDiscovered} discovered`,
  );

  // ── Phase 2: AST parsing ───────────────────────────────────────────────────
  const parseSpinner = ora(`Parsing ${files.length} file(s)…`).start();
  const parsedFiles: ParsedFile[] = [];
  let parseFailCount = 0;

  for (const fileInfo of files) {
    try {
      const parsed = parseFile(fileInfo.absolutePath, fileInfo.content);
      if (parsed === null) {
        parseFailCount++;
        errors.push({
          file: fileInfo.relativePath,
          message: 'AST parsing returned null (unsupported syntax or parser error)',
          phase: 'parse',
        });
        logger.debug(`Analyzer: parse returned null for "${fileInfo.relativePath}"`);
      } else {
        parsedFiles.push(parsed);
      }
    } catch (err) {
      parseFailCount++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ file: fileInfo.relativePath, message, phase: 'parse' });
      logger.debug(`Analyzer: parse threw for "${fileInfo.relativePath}" — ${message}`);
    }
  }

  if (parseFailCount > 0) {
    parseSpinner.warn(
      `Parsed ${parsedFiles.length}/${files.length} file(s) — ${parseFailCount} parse error(s)`,
    );
  } else {
    parseSpinner.succeed(`Parsed ${parsedFiles.length}/${files.length} file(s) successfully`);
  }

  logger.info(
    `Analyzer: ${parsedFiles.length} file(s) parsed successfully, ${parseFailCount} failed`,
  );

  // ── Phase 3: Checks ────────────────────────────────────────────────────────
  const checkSpinner = ora('Running checks…').start();

  // Dependency check is synchronous and reads package.json directly.
  const dependencyIssues = safeSync(
    'analyze',
    'dependency',
    () => checkDependencies(resolvedRoot, parsedFiles, config),
    errors,
    [],
  );

  // The remaining checks are either synchronous (imports, variables, env) or
  // async (security).  Run them concurrently.
  const [importIssues, variableIssues, securityIssues, envIssues] =
    await Promise.all([
      safeAsync(
        'analyze',
        'imports',
        async () => checkImports(parsedFiles, config),
        errors,
        [],
      ),
      safeAsync(
        'analyze',
        'variables',
        async () => checkVariables(parsedFiles, config),
        errors,
        [],
      ),
      safeAsync(
        'analyze',
        'security',
        () => checkSecurity(resolvedRoot, config),
        errors,
        [],
      ),
      safeAsync(
        'analyze',
        'env',
        async () => checkEnv(resolvedRoot, config),
        errors,
        [],
      ),
    ]);

  const totalIssues =
    dependencyIssues.length +
    importIssues.length +
    variableIssues.length +
    securityIssues.length +
    envIssues.length;

  checkSpinner.succeed(`Checks complete — ${totalIssues} issue(s) found`);

  // ── Phase 4: Assemble result ───────────────────────────────────────────────
  const durationMs = Date.now() - start;

  logger.info(
    `Analyzer: scan finished in ${durationMs}ms — ` +
      `${files.length} file(s) scanned, ${parsedFiles.length} parsed, ` +
      `${totalIssues} issue(s), ${errors.length} error(s)`,
  );

  return {
    projectRoot: resolvedRoot,
    filesScanned: files.length,
    dependencyIssues,
    importIssues,
    variableIssues,
    securityIssues,
    envIssues,
    errors,
    durationMs,
  };
}
