import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Determine whether `filePath` is strictly inside `root`.
 *
 * Uses `path.resolve` on both sides so that relative segments, symlink
 * differences in casing, and trailing slashes are all normalised before the
 * comparison.  A file that resolves to exactly `root` is NOT considered to be
 * "inside" it — it must be a strict descendant.
 */
export function isInsideRoot(root: string, filePath: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(filePath);

  // path.relative returns '' when both paths are equal, and starts with '..'
  // when the file escapes the root.
  const rel = path.relative(resolvedRoot, resolvedFile);

  // Empty string means exact equality — not inside.
  // Starts with '..' means the path escapes root.
  // path.isAbsolute(rel) catches Windows drive-letter divergence.
  return (
    rel.length > 0 &&
    !rel.startsWith('..') &&
    !path.isAbsolute(rel)
  );
}

/**
 * Stat `filePath` without throwing.  Returns `null` on any error (ENOENT,
 * EACCES, etc.).
 */
export function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Read `filePath` synchronously without throwing.
 *
 * @param filePath  Absolute path to read.
 * @param maxBytes  Maximum number of bytes to read.  If the file is larger,
 *                  `null` is returned (caller should skip the file).
 * @returns The file contents as a UTF-8 string, or `null` on any error or if
 *          the file exceeds `maxBytes`.
 */
export function safeReadFile(filePath: string, maxBytes: number): string | null {
  try {
    const stats = fs.statSync(filePath);

    if (!stats.isFile()) {
      return null;
    }

    if (stats.size > maxBytes) {
      return null;
    }

    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Join `root` with `parts`, resolve the result, and verify that it stays
 * inside `root`.
 *
 * Returns the resolved absolute path when safe, or `null` when the resolved
 * path would escape `root` (path-traversal attempt).
 *
 * @example
 * resolveWithinRoot('/project', 'src', '../../../etc/passwd') // => null
 * resolveWithinRoot('/project', 'src', 'index.ts')           // => '/project/src/index.ts'
 */
export function resolveWithinRoot(root: string, ...parts: string[]): string | null {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...parts);

  if (!isInsideRoot(resolvedRoot, candidate)) {
    return null;
  }

  return candidate;
}

/**
 * Check whether `filePath` is a symbolic link.
 *
 * Uses `lstat` so that the link itself is examined rather than the target.
 * Returns `false` on any error (e.g. the path does not exist).
 */
export function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}
