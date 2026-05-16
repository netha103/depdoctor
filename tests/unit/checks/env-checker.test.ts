import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { checkEnv } from '../../../src/checks/env/env-checker.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depdoctor-env-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const defaultConfig = {
  ignoreDependencies: [],
  ignoreVariables: [],
  ignoreFiles: [],
  ignorePackages: [],
  security: true,
  fix: false,
  maxFileSizeMB: 10,
  maxFiles: 10000,
  maxDepth: 20,
  includeDevDependencies: true,
  reportFormat: 'terminal' as const,
};

describe('checkEnv', () => {
  it('returns empty array when no .env files exist', () => {
    const issues = checkEnv(tmpDir, defaultConfig);
    expect(issues).toHaveLength(0);
  });

  it('does not flag valid SCREAMING_SNAKE_CASE variable names', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'DATABASE_URL=postgres://localhost/db\nAPI_KEY=secret');
    const issues = checkEnv(tmpDir, defaultConfig);
    expect(issues.filter((i) => i.type === 'invalid-name')).toHaveLength(0);
  });

  it('flags invalid variable names (lowercase)', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'database_url=postgres://localhost/db');
    const issues = checkEnv(tmpDir, defaultConfig);
    expect(issues.some((i) => i.type === 'invalid-name' && i.variable === 'database_url')).toBe(true);
  });

  it('flags invalid variable names (camelCase)', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'myApiKey=secret');
    const issues = checkEnv(tmpDir, defaultConfig);
    expect(issues.some((i) => i.type === 'invalid-name' && i.variable === 'myApiKey')).toBe(true);
  });

  it('flags duplicate variables across .env files', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'API_KEY=prod-key');
    fs.writeFileSync(path.join(tmpDir, '.env.local'), 'API_KEY=local-key');
    const issues = checkEnv(tmpDir, defaultConfig);
    expect(issues.some((i) => i.type === 'duplicate' && i.variable === 'API_KEY')).toBe(true);
  });

  it('ignores blank lines and comments in .env files', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), '# This is a comment\n\nAPI_KEY=value\n');
    const issues = checkEnv(tmpDir, defaultConfig);
    expect(issues.filter((i) => i.type === 'invalid-name')).toHaveLength(0);
  });

  it('handles export prefix in .env files', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'export DATABASE_URL=postgres://localhost/db');
    const issues = checkEnv(tmpDir, defaultConfig);
    expect(issues.filter((i) => i.type === 'invalid-name')).toHaveLength(0);
  });

  it('does not crash on malformed .env files', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), '=noequalssign\nKEY_ONLY\n===');
    expect(() => checkEnv(tmpDir, defaultConfig)).not.toThrow();
  });
});
