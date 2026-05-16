/**
 * File scanner — discovers source files under a project root using glob and
 * applies DOS-protection limits (maxFiles, maxDepth, maxFileSizeMB).
 */

import { glob } from 'glob';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Config, FileInfo, ScanError } from '../../types.js';
import {
  safeReadFile,
  safeStat,
  isSymlink,
  isInsideRoot,
} from '../../utils/path-safety.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.cache/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/out/**',
  '**/.git/**',
];

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_DEPTH = 20;
const DEFAULT_MAX_FILE_SIZE_MB = 10;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScannerResult {
  /** All successfully read source files. */
  files: FileInfo[];

  /** Non-fatal errors encountered during scanning. */
  errors: ScanError[];

  /**
   * Total number of paths matched by glob before applying limits or skipping
   * files that could not be read.  Useful for diagnostics / reporting.
   */
  totalDiscovered: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the combined ignore-glob list: built-in defaults + caller-supplied
 * patterns from `config.ignoreFiles`.
 */
function buildIgnoreList(config: Config): string[] {
  const extra = config.ignoreFiles ?? [];
  return [...DEFAULT_IGNORE, ...extra];
}

/**
 * Convert a `maxDepth` limit into a glob `maxDepth` option value.
 *
 * The glob `maxDepth` counts path components *below* `cwd`, so depth 1 means
 * only immediate children.  We add 1 to convert the "directory nesting depth"
 * semantic used in the config into glob's "component count" semantic.
 */
function toGlobDepth(maxDepth: number): number {
  // maxDepth=20 → allow 20 levels of directory nesting → 21 components
  return maxDepth + 1;
}

/**
 * Return true only for plain files (not directories, devices, etc.) that are
 * not symbolic links.
 */
function isRegularFile(filePath: string): boolean {
  const stat = safeStat(filePath);
  if (stat === null) return false;
  return stat.isFile() && !fs.lstatSync(filePath).isSymbolicLink();
}

// ---------------------------------------------------------------------------
// Core scanner
// ---------------------------------------------------------------------------

/**
 * Scan `projectRoot` for JavaScript / TypeScript source files.
 *
 * - Respects `config.ignoreFiles` patterns in addition to the built-in defaults.
 * - Enforces `config.maxFiles`, `config.maxDepth`, and `config.maxFileSizeMB`
 *   DOS-protection limits.
 * - Skips symbolic links.
 * - Never throws — all I/O errors are captured in `ScannerResult.errors`.
 *
 * @param projectRoot  Absolute path to the project being analysed.
 * @param config       Resolved depdoctor configuration.
 */
export async function scanFiles(
  projectRoot: string,
  config: Config,
): Promise<ScannerResult> {
  const files: FileInfo[] = [];
  const errors: ScanError[] = [];

  const resolvedRoot = path.resolve(projectRoot);
  const maxFiles = config.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFileSizeMB = config.maxFileSizeMB ?? DEFAULT_MAX_FILE_SIZE_MB;
  const maxBytes = maxFileSizeMB * 1024 * 1024;

  // ------------------------------------------------------------------
  // Glob discovery
  // ------------------------------------------------------------------
  let discovered: string[] = [];

  try {
    discovered = await glob('**/*', {
      cwd: resolvedRoot,
      absolute: true,
      nodir: true,
      dot: false,
      follow: false,          // never follow symlinks
      ignore: buildIgnoreList(config),
      maxDepth: toGlobDepth(maxDepth),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Scanner: glob failed for "${resolvedRoot}" — ${message}`);
    errors.push({ file: resolvedRoot, message: `glob failed: ${message}`, phase: 'scan' });
    return { files, errors, totalDiscovered: 0 };
  }

  const totalDiscovered = discovered.length;
  logger.debug(`Scanner: glob found ${totalDiscovered} paths under "${resolvedRoot}"`);

  // ------------------------------------------------------------------
  // Filter, validate, and read
  // ------------------------------------------------------------------
  let accepted = 0;

  for (const absolutePath of discovered) {
    // Hard cap on the total number of files processed.
    if (accepted >= maxFiles) {
      logger.warn(
        `Scanner: maxFiles limit (${maxFiles}) reached — skipping remaining files. ` +
          `Use config.maxFiles to increase the limit.`,
      );
      break;
    }

    const ext = path.extname(absolutePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      logger.debug(`Scanner: skipping unsupported extension "${ext}" — ${absolutePath}`);
      continue;
    }

    // Reject paths that escape the project root (should not happen with glob's
    // cwd, but guard against exotic symlink resolution edge cases).
    if (!isInsideRoot(resolvedRoot, absolutePath)) {
      logger.warn(`Scanner: path escapes project root, skipping — ${absolutePath}`);
      errors.push({
        file: absolutePath,
        message: 'Path escapes project root',
        phase: 'scan',
      });
      continue;
    }

    // Symlink check (belt-and-suspenders: glob follow:false should handle this).
    if (isSymlink(absolutePath)) {
      logger.debug(`Scanner: skipping symlink — ${absolutePath}`);
      continue;
    }

    // Must be a regular file.
    if (!isRegularFile(absolutePath)) {
      logger.debug(`Scanner: skipping non-regular file — ${absolutePath}`);
      continue;
    }

    // Size guard — stat before reading to avoid loading huge files.
    const stat = safeStat(absolutePath);
    if (stat === null) {
      logger.warn(`Scanner: could not stat "${absolutePath}" — skipping`);
      errors.push({ file: absolutePath, message: 'Could not stat file', phase: 'scan' });
      continue;
    }

    if (stat.size > maxBytes) {
      logger.warn(
        `Scanner: file exceeds maxFileSizeMB (${maxFileSizeMB} MB) — skipping "${absolutePath}"`,
      );
      errors.push({
        file: absolutePath,
        message: `File size (${(stat.size / 1024 / 1024).toFixed(2)} MB) exceeds limit of ${maxFileSizeMB} MB`,
        phase: 'scan',
      });
      continue;
    }

    // Read content.
    const content = safeReadFile(absolutePath, maxBytes);
    if (content === null) {
      logger.warn(`Scanner: could not read "${absolutePath}" — skipping`);
      errors.push({ file: absolutePath, message: 'Could not read file', phase: 'scan' });
      continue;
    }

    const relativePath = path.relative(resolvedRoot, absolutePath);

    files.push({
      absolutePath,
      relativePath,
      content,
      sizeBytes: stat.size,
    });

    accepted++;
    logger.debug(`Scanner: accepted [${accepted}/${maxFiles}] "${relativePath}"`);
  }

  logger.info(
    `Scanner: ${files.length} file(s) accepted, ` +
      `${errors.length} error(s), ` +
      `${totalDiscovered} path(s) discovered.`,
  );

  return { files, errors, totalDiscovered };
}
