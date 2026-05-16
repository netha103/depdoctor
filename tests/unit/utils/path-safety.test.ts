import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  isInsideRoot,
  safeStat,
  safeReadFile,
  resolveWithinRoot,
  isSymlink,
} from '../../../src/utils/path-safety.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depdoctor-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── isInsideRoot ────────────────────────────────────────────────────────────

describe('isInsideRoot', () => {
  it('returns true for a file directly inside root', () => {
    expect(isInsideRoot(tmpDir, path.join(tmpDir, 'file.ts'))).toBe(true);
  });

  it('returns true for a nested file', () => {
    expect(isInsideRoot(tmpDir, path.join(tmpDir, 'a', 'b', 'file.ts'))).toBe(true);
  });

  it('returns false for path traversal attempt', () => {
    expect(isInsideRoot(tmpDir, path.join(tmpDir, '..', 'evil.ts'))).toBe(false);
  });

  it('returns false for absolute path outside root', () => {
    expect(isInsideRoot(tmpDir, '/etc/passwd')).toBe(false);
  });

  it('returns false for root itself (not a file inside)', () => {
    expect(isInsideRoot(tmpDir, tmpDir)).toBe(false);
  });

  it('rejects encoded traversal sequences', () => {
    const encoded = path.resolve(tmpDir, '..%2Fevil');
    expect(isInsideRoot(tmpDir, encoded)).toBe(false);
  });
});

// ─── safeStat ────────────────────────────────────────────────────────────────

describe('safeStat', () => {
  it('returns Stats for an existing file', () => {
    const file = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(file, 'hello');
    const stats = safeStat(file);
    expect(stats).not.toBeNull();
    expect(stats?.isFile()).toBe(true);
  });

  it('returns null for a non-existent file', () => {
    expect(safeStat(path.join(tmpDir, 'ghost.txt'))).toBeNull();
  });

  it('does not throw for inaccessible paths', () => {
    expect(() => safeStat('/root/secret')).not.toThrow();
  });
});

// ─── safeReadFile ────────────────────────────────────────────────────────────

describe('safeReadFile', () => {
  it('reads a file within size limit', () => {
    const file = path.join(tmpDir, 'hello.txt');
    fs.writeFileSync(file, 'hello world');
    const content = safeReadFile(file, 1024);
    expect(content).toBe('hello world');
  });

  it('returns null when file exceeds maxBytes', () => {
    const file = path.join(tmpDir, 'big.txt');
    fs.writeFileSync(file, 'x'.repeat(100));
    const content = safeReadFile(file, 50);
    expect(content).toBeNull();
  });

  it('returns null for non-existent file', () => {
    expect(safeReadFile(path.join(tmpDir, 'missing.txt'), 1024)).toBeNull();
  });

  it('reads empty file as empty string', () => {
    const file = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(file, '');
    expect(safeReadFile(file, 1024)).toBe('');
  });
});

// ─── resolveWithinRoot ───────────────────────────────────────────────────────

describe('resolveWithinRoot', () => {
  it('resolves a valid sub-path', () => {
    const result = resolveWithinRoot(tmpDir, 'src', 'index.ts');
    expect(result).toBe(path.join(tmpDir, 'src', 'index.ts'));
  });

  it('returns null for traversal attempt', () => {
    expect(resolveWithinRoot(tmpDir, '..', 'evil.ts')).toBeNull();
  });

  it('returns null for absolute path outside root', () => {
    expect(resolveWithinRoot(tmpDir, '/etc/passwd')).toBeNull();
  });
});

// ─── isSymlink ───────────────────────────────────────────────────────────────

describe('isSymlink', () => {
  it('returns false for a regular file', () => {
    const file = path.join(tmpDir, 'regular.txt');
    fs.writeFileSync(file, 'hi');
    expect(isSymlink(file)).toBe(false);
  });

  it('returns true for a symlink', () => {
    const target = path.join(tmpDir, 'target.txt');
    const link = path.join(tmpDir, 'link.txt');
    fs.writeFileSync(target, 'content');
    fs.symlinkSync(target, link);
    expect(isSymlink(link)).toBe(true);
  });

  it('returns false for non-existent path', () => {
    expect(isSymlink(path.join(tmpDir, 'nothing'))).toBe(false);
  });
});
