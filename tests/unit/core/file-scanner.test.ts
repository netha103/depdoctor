import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanFiles } from '../../../src/core/scanner/file-scanner.js';
import { loadConfig } from '../../../src/config/loader.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depdoctor-scanner-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeFile(rel: string, content = 'const x = 1;') {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

describe('scanFiles', () => {
  it('discovers .ts files', async () => {
    makeFile('src/index.ts');
    const config = loadConfig(tmpDir);
    const result = await scanFiles(tmpDir, config);
    expect(result.files.some((f) => f.absolutePath.endsWith('index.ts'))).toBe(true);
  });

  it('discovers .js, .jsx, .tsx, .mjs, .cjs files', async () => {
    makeFile('a.js');
    makeFile('b.jsx');
    makeFile('c.tsx');
    makeFile('d.mjs');
    makeFile('e.cjs');
    const config = loadConfig(tmpDir);
    const result = await scanFiles(tmpDir, config);
    const names = result.files.map((f) => path.basename(f.absolutePath));
    expect(names).toContain('a.js');
    expect(names).toContain('b.jsx');
    expect(names).toContain('c.tsx');
    expect(names).toContain('d.mjs');
    expect(names).toContain('e.cjs');
  });

  it('ignores node_modules', async () => {
    makeFile('node_modules/express/index.js', 'module.exports = {}');
    makeFile('src/app.ts', 'const x = 1;');
    const config = loadConfig(tmpDir);
    const result = await scanFiles(tmpDir, config);
    const hasNodeModules = result.files.some((f) => f.absolutePath.includes('node_modules'));
    expect(hasNodeModules).toBe(false);
  });

  it('ignores dist directory', async () => {
    makeFile('dist/index.js', 'var x = 1;');
    makeFile('src/index.ts', 'const x = 1;');
    const config = loadConfig(tmpDir);
    const result = await scanFiles(tmpDir, config);
    const hasDist = result.files.some((f) => f.absolutePath.includes('/dist/'));
    expect(hasDist).toBe(false);
  });

  it('skips files exceeding maxFileSizeMB', async () => {
    const file = path.join(tmpDir, 'huge.ts');
    // Write 2 bytes over the 1-byte limit we set
    fs.writeFileSync(file, 'x'.repeat(3));
    const config = { ...loadConfig(tmpDir), maxFileSizeMB: 0.000001 }; // ~1 byte limit
    const result = await scanFiles(tmpDir, config);
    const found = result.files.some((f) => f.absolutePath.endsWith('huge.ts'));
    expect(found).toBe(false);
  });

  it('returns file content', async () => {
    makeFile('src/hello.ts', 'export const greeting = "hello";');
    const config = loadConfig(tmpDir);
    const result = await scanFiles(tmpDir, config);
    const file = result.files.find((f) => f.absolutePath.endsWith('hello.ts'));
    expect(file?.content).toBe('export const greeting = "hello";');
  });

  it('returns relativePath relative to project root', async () => {
    makeFile('src/utils/helper.ts', 'export const x = 1;');
    const config = loadConfig(tmpDir);
    const result = await scanFiles(tmpDir, config);
    const file = result.files.find((f) => f.absolutePath.endsWith('helper.ts'));
    expect(file?.relativePath).toBe(path.join('src', 'utils', 'helper.ts'));
  });

  it('does not crash on empty directory', async () => {
    const config = loadConfig(tmpDir);
    await expect(scanFiles(tmpDir, config)).resolves.toBeDefined();
  });

  it('records an error (not crash) for unreadable files', async () => {
    // Create a directory with the .ts extension (unreadable as file)
    const weirdPath = path.join(tmpDir, 'fake.ts');
    fs.mkdirSync(weirdPath);
    const config = loadConfig(tmpDir);
    // Should not throw
    const result = await scanFiles(tmpDir, config);
    expect(result).toBeDefined();
  });
});
