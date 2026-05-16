/**
 * Integration tests: create a real fixture project on disk, run analyzeProject,
 * and assert on the ScanResult.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { analyzeProject } from '../../src/core/analyzer/project-analyzer.js';
import { loadConfig } from '../../src/config/loader.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depdoctor-integration-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

// ─── Fixture: project with one unused dep ─────────────────────────────────────

describe('analyzeProject — unused dependency', () => {
  it('detects dependency listed in package.json but never imported', async () => {
    write('package.json', JSON.stringify({
      name: 'fixture',
      dependencies: { axios: '^1.0.0', lodash: '^4.0.0' },
    }));
    write('src/index.ts', `
      import axios from 'axios';
      export const fetchData = () => axios.get('/api');
    `);

    const config = { ...loadConfig(tmpDir), security: false };
    const result = await analyzeProject(tmpDir, config);

    expect(result.dependencyIssues.some((i) => i.name === 'lodash' && i.type === 'unused')).toBe(true);
    expect(result.dependencyIssues.some((i) => i.name === 'axios')).toBe(false);
  });
});

// ─── Fixture: project with unused import ─────────────────────────────────────

describe('analyzeProject — unused import specifier', () => {
  it('detects imported specifier that is never used', async () => {
    write('package.json', JSON.stringify({ name: 'fixture', dependencies: { chalk: '^5.0.0' } }));
    write('src/app.ts', `
      import { red, blue } from 'chalk';
      console.log(red('error'));
      // blue is imported but never used
    `);

    const config = { ...loadConfig(tmpDir), security: false };
    const result = await analyzeProject(tmpDir, config);

    expect(result.importIssues.some((i) => i.specifier === 'blue')).toBe(true);
    expect(result.importIssues.some((i) => i.specifier === 'red')).toBe(false);
  });
});

// ─── Fixture: project with unused variable ────────────────────────────────────

describe('analyzeProject — unused variable', () => {
  it('detects declared variable that is never referenced', async () => {
    write('package.json', JSON.stringify({ name: 'fixture', dependencies: {} }));
    write('src/utils.ts', `
      const UNUSED_CONSTANT = 'never used';
      export const helper = () => 'hello';
    `);

    const config = { ...loadConfig(tmpDir), security: false };
    const result = await analyzeProject(tmpDir, config);

    expect(result.variableIssues.some((i) => i.name === 'UNUSED_CONSTANT')).toBe(true);
    expect(result.variableIssues.some((i) => i.name === 'helper')).toBe(false);
  });
});

// ─── Fixture: clean project ───────────────────────────────────────────────────

describe('analyzeProject — clean project', () => {
  it('returns no issues for a well-formed project', async () => {
    write('package.json', JSON.stringify({ name: 'fixture', dependencies: { chalk: '^5.0.0' } }));
    write('src/index.ts', `
      import chalk from 'chalk';
      export const greet = (name: string) => chalk.green(\`Hello, \${name}\`);
    `);

    const config = { ...loadConfig(tmpDir), security: false };
    const result = await analyzeProject(tmpDir, config);

    expect(result.dependencyIssues).toHaveLength(0);
    expect(result.importIssues).toHaveLength(0);
    expect(result.variableIssues).toHaveLength(0);
  });
});

// ─── Fixture: parse errors are isolated ──────────────────────────────────────

describe('analyzeProject — resilience', () => {
  it('continues scanning when one file has invalid syntax', async () => {
    write('package.json', JSON.stringify({ name: 'fixture', dependencies: { chalk: '^5.0.0' } }));
    write('src/good.ts', `import chalk from 'chalk'; export const x = chalk.red('hi');`);
    write('src/broken.ts', `this is not <<< valid >>> typescript !!!`);

    const config = { ...loadConfig(tmpDir), security: false };
    const result = await analyzeProject(tmpDir, config);

    // Broken file recorded as error, not a crash
    expect(result.errors.some((e) => e.file.endsWith('broken.ts'))).toBe(true);
    // Good file still scanned
    expect(result.filesScanned).toBeGreaterThanOrEqual(1);
  });

  it('returns a valid ScanResult even for completely empty project', async () => {
    write('package.json', JSON.stringify({ name: 'empty' }));
    const config = { ...loadConfig(tmpDir), security: false };
    const result = await analyzeProject(tmpDir, config);
    expect(result).toBeDefined();
    expect(result.filesScanned).toBe(0);
  });
});

// ─── Fixture: .depdoctorrc respected ─────────────────────────────────────────

describe('analyzeProject — config file', () => {
  it('respects ignoreDependencies from .depdoctorrc', async () => {
    write('package.json', JSON.stringify({ name: 'fixture', dependencies: { moment: '^2.0.0' } }));
    write('.depdoctorrc', JSON.stringify({ ignoreDependencies: ['moment'], security: false }));
    write('src/index.ts', `export const x = 1;`);

    const config = loadConfig(tmpDir);
    const result = await analyzeProject(tmpDir, config);

    expect(result.dependencyIssues.some((i) => i.name === 'moment')).toBe(false);
  });
});
