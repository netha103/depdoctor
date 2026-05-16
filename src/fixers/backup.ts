/**
 * Backup / rollback system for depdoctor fix operations.
 *
 * Before any file modification is written to disk, createBackup() snapshots
 * every file that will be touched (plus package.json and the lockfile) into
 * `.depdoctor-backup/<ISO-timestamp>/`.  A `manifest.json` in that directory
 * records what was captured so that restoreLatestBackup() can reconstruct the
 * originals precisely.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BACKUP_DIR = '.depdoctor-backup';
const MANIFEST_FILE = 'manifest.json';
const GITIGNORE_FILE = '.gitignore';

/** Lockfile candidates checked in order. */
const LOCKFILE_NAMES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BackupManifest {
  timestamp: string;
  projectRoot: string;
  files: string[];
  packageJsonPath: string | null;
  lockfilePath: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Generate a filesystem-safe ISO 8601 timestamp string
 * (colons replaced with hyphens so it works as a directory name on Windows).
 */
function makeTimestamp(): string {
  return new Date().toISOString().replace(/:/g, '-');
}

/**
 * Copy `src` to `dest`, creating intermediate directories as needed.
 * Throws on any I/O error.
 */
function copyFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/**
 * Locate the lockfile for `projectRoot`, returning its absolute path or null.
 */
function findLockfile(projectRoot: string): string | null {
  for (const name of LOCKFILE_NAMES) {
    const candidate = path.join(projectRoot, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // not found — try next
    }
  }
  return null;
}

/**
 * Compute the destination path for a backed-up file.
 *
 * Files are stored under `backupRoot` with their path relative to
 * `projectRoot` preserved, so that the restore step can reconstruct
 * them in the right place.
 *
 * A leading `/` or drive letter is removed from absolute paths so the
 * relative copy doesn't attempt to create a root-level directory.
 */
function destForFile(backupRoot: string, projectRoot: string, absoluteFilePath: string): string {
  const rel = path.relative(projectRoot, absoluteFilePath);
  return path.join(backupRoot, rel);
}

/**
 * Add `entry` to the project's `.gitignore` if it isn't already present.
 * Creates the file if it doesn't exist yet.
 */
function ensureGitignoreEntry(projectRoot: string, entry: string): void {
  const gitignorePath = path.join(projectRoot, GITIGNORE_FILE);
  let existing = '';

  try {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    // file doesn't exist yet — we'll create it
  }

  const lines = existing.split('\n');
  const alreadyPresent = lines.some((l) => l.trim() === entry);

  if (alreadyPresent) return;

  const updated = existing.endsWith('\n') || existing === ''
    ? existing + entry + '\n'
    : existing + '\n' + entry + '\n';

  try {
    fs.writeFileSync(gitignorePath, updated, 'utf-8');
    logger.debug(`Backup: added "${entry}" to .gitignore`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Backup: could not update .gitignore: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a timestamped backup snapshot of `filesToBackup` (plus package.json
 * and the lockfile) under `<projectRoot>/.depdoctor-backup/<timestamp>/`.
 *
 * @returns The absolute path to the created backup directory.
 */
export async function createBackup(
  projectRoot: string,
  filesToBackup: string[],
): Promise<string> {
  const resolvedRoot = path.resolve(projectRoot);
  const timestamp = makeTimestamp();
  const backupRoot = path.join(resolvedRoot, BACKUP_DIR, timestamp);

  logger.debug(`Backup: creating snapshot at "${backupRoot}"`);
  fs.mkdirSync(backupRoot, { recursive: true });

  const backedUpFiles: string[] = [];

  // ── Back up the caller-supplied files ───────────────────────────────────
  for (const filePath of filesToBackup) {
    const absolutePath = path.resolve(resolvedRoot, filePath);

    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile()) {
        logger.debug(`Backup: skipping non-file "${absolutePath}"`);
        continue;
      }
    } catch {
      logger.debug(`Backup: skipping missing file "${absolutePath}"`);
      continue;
    }

    const dest = destForFile(backupRoot, resolvedRoot, absolutePath);
    copyFile(absolutePath, dest);
    backedUpFiles.push(absolutePath);
    logger.debug(`Backup: copied "${absolutePath}" → "${dest}"`);
  }

  // ── Back up package.json ────────────────────────────────────────────────
  const pkgJsonPath = path.join(resolvedRoot, 'package.json');
  let backedUpPkgJson: string | null = null;

  try {
    const stat = fs.statSync(pkgJsonPath);
    if (stat.isFile()) {
      const dest = destForFile(backupRoot, resolvedRoot, pkgJsonPath);
      copyFile(pkgJsonPath, dest);
      backedUpPkgJson = pkgJsonPath;
      logger.debug(`Backup: copied package.json → "${dest}"`);
    }
  } catch {
    logger.debug('Backup: package.json not found — skipping');
  }

  // ── Back up lockfile ─────────────────────────────────────────────────────
  const lockfilePath = findLockfile(resolvedRoot);
  let backedUpLockfile: string | null = null;

  if (lockfilePath !== null) {
    const dest = destForFile(backupRoot, resolvedRoot, lockfilePath);
    copyFile(lockfilePath, dest);
    backedUpLockfile = lockfilePath;
    logger.debug(`Backup: copied "${path.basename(lockfilePath)}" → "${dest}"`);
  } else {
    logger.debug('Backup: no lockfile found — skipping');
  }

  // ── Write manifest ───────────────────────────────────────────────────────
  const manifest: BackupManifest = {
    timestamp,
    projectRoot: resolvedRoot,
    files: backedUpFiles,
    packageJsonPath: backedUpPkgJson,
    lockfilePath: backedUpLockfile,
  };

  const manifestPath = path.join(backupRoot, MANIFEST_FILE);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  logger.debug(`Backup: manifest written to "${manifestPath}"`);

  // ── Ensure .depdoctor-backup is in .gitignore ────────────────────────────
  ensureGitignoreEntry(resolvedRoot, BACKUP_DIR);

  const count = backedUpFiles.length + (backedUpPkgJson !== null ? 1 : 0) + (backedUpLockfile !== null ? 1 : 0);
  logger.success(`Backup: snapshot created — ${count} file(s) backed up to "${backupRoot}"`);

  return backupRoot;
}

/**
 * Restore the most recent backup found inside
 * `<projectRoot>/.depdoctor-backup/`.
 *
 * The function reads the backup's `manifest.json` and copies every recorded
 * file back to its original location.
 *
 * @throws When no backup directory exists or the manifest cannot be read.
 */
export async function restoreLatestBackup(projectRoot: string): Promise<void> {
  const resolvedRoot = path.resolve(projectRoot);
  const backupBaseDir = path.join(resolvedRoot, BACKUP_DIR);

  // ── Find most-recent snapshot ────────────────────────────────────────────
  let entries: string[];
  try {
    entries = fs.readdirSync(backupBaseDir);
  } catch {
    throw new Error(`No backup directory found at "${backupBaseDir}". Nothing to restore.`);
  }

  const snapshots = entries
    .filter((e) => {
      try {
        return fs.statSync(path.join(backupBaseDir, e)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort() // ISO timestamps sort lexicographically == chronologically
    .reverse();

  if (snapshots.length === 0) {
    throw new Error(`No backup snapshots found inside "${backupBaseDir}".`);
  }

  const latestSnapshot = snapshots[0]!;
  const backupRoot = path.join(backupBaseDir, latestSnapshot);

  // ── Read manifest ─────────────────────────────────────────────────────────
  const manifestPath = path.join(backupRoot, MANIFEST_FILE);
  let manifest: BackupManifest;

  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    manifest = JSON.parse(raw) as BackupManifest;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read backup manifest at "${manifestPath}": ${msg}`);
  }

  logger.info(`Restore: using snapshot "${latestSnapshot}" (${manifest.timestamp})`);

  // ── Restore files ─────────────────────────────────────────────────────────
  const allToRestore: string[] = [
    ...manifest.files,
    ...(manifest.packageJsonPath !== null ? [manifest.packageJsonPath] : []),
    ...(manifest.lockfilePath !== null ? [manifest.lockfilePath] : []),
  ];

  let restoredCount = 0;

  for (const originalPath of allToRestore) {
    const backedUpPath = destForFile(backupRoot, resolvedRoot, originalPath);

    try {
      fs.accessSync(backedUpPath, fs.constants.R_OK);
    } catch {
      logger.warn(`Restore: backed-up file not found: "${backedUpPath}" — skipping`);
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(originalPath), { recursive: true });
      fs.copyFileSync(backedUpPath, originalPath);
      restoredCount++;
      logger.debug(`Restore: "${backedUpPath}" → "${originalPath}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Restore: failed to restore "${originalPath}": ${msg}`);
    }
  }

  logger.success(`Restore: ${restoredCount} file(s) restored from snapshot "${latestSnapshot}"`);
}

/**
 * Return the list of all backup manifests found inside
 * `<projectRoot>/.depdoctor-backup/`, sorted from newest to oldest.
 *
 * Returns an empty array when no backups exist.
 */
export function listBackups(projectRoot: string): BackupManifest[] {
  const resolvedRoot = path.resolve(projectRoot);
  const backupBaseDir = path.join(resolvedRoot, BACKUP_DIR);

  let entries: string[];
  try {
    entries = fs.readdirSync(backupBaseDir);
  } catch {
    return [];
  }

  const manifests: BackupManifest[] = [];

  const snapshots = entries
    .filter((e) => {
      try {
        return fs.statSync(path.join(backupBaseDir, e)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse(); // newest first

  for (const snapshot of snapshots) {
    const manifestPath = path.join(backupBaseDir, snapshot, MANIFEST_FILE);
    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as BackupManifest;
      manifests.push(manifest);
    } catch {
      // Corrupt or missing manifest — skip this snapshot silently.
      logger.debug(`Backup: skipping corrupt/missing manifest in "${snapshot}"`);
    }
  }

  return manifests;
}
