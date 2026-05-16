import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from '../../../src/config/loader.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depdoctor-config-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns default config when no rc file exists', () => {
    const config = loadConfig(tmpDir);
    expect(config.security).toBe(true);
    expect(config.fix).toBe(false);
    expect(config.maxFileSizeMB).toBe(10);
    expect(config.maxFiles).toBe(10000);
    expect(config.maxDepth).toBe(20);
    expect(config.ignoreDependencies).toEqual([]);
    expect(config.ignoreVariables).toEqual([]);
  });

  it('loads .depdoctorrc and merges with defaults', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.depdoctorrc'),
      JSON.stringify({ security: false, maxFileSizeMB: 5 }),
    );
    const config = loadConfig(tmpDir);
    expect(config.security).toBe(false);
    expect(config.maxFileSizeMB).toBe(5);
    // defaults still apply for unset fields
    expect(config.fix).toBe(false);
    expect(config.maxFiles).toBe(10000);
  });

  it('loads .depdoctorrc.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.depdoctorrc.json'),
      JSON.stringify({ ignoreDependencies: ['react', 'lodash'] }),
    );
    const config = loadConfig(tmpDir);
    expect(config.ignoreDependencies).toEqual(['react', 'lodash']);
  });

  it('handles invalid JSON gracefully and uses defaults', () => {
    fs.writeFileSync(path.join(tmpDir, '.depdoctorrc'), 'this is not json {{{');
    expect(() => loadConfig(tmpDir)).not.toThrow();
    const config = loadConfig(tmpDir);
    expect(config.maxFiles).toBe(10000);
  });

  it('ignores unknown config fields without throwing', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.depdoctorrc'),
      JSON.stringify({ unknownField: true, anotherBadField: 42 }),
    );
    expect(() => loadConfig(tmpDir)).not.toThrow();
  });

  it('validates maxFileSizeMB type — falls back to default on wrong type', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.depdoctorrc'),
      JSON.stringify({ maxFileSizeMB: 'huge' }),
    );
    const config = loadConfig(tmpDir);
    expect(typeof config.maxFileSizeMB).toBe('number');
  });

  it('prefers .depdoctorrc over .depdoctorrc.json when both exist', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.depdoctorrc'),
      JSON.stringify({ maxFileSizeMB: 3 }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.depdoctorrc.json'),
      JSON.stringify({ maxFileSizeMB: 7 }),
    );
    const config = loadConfig(tmpDir);
    expect(config.maxFileSizeMB).toBe(3);
  });
});
