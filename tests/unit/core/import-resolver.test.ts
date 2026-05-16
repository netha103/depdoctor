import { describe, it, expect } from 'vitest';
import {
  resolveImport,
  extractPackageName,
} from '../../../src/core/resolver/import-resolver.js';

describe('resolveImport', () => {
  it('identifies relative imports as local', () => {
    expect(resolveImport('./utils').kind).toBe('local');
    expect(resolveImport('../helpers/index').kind).toBe('local');
    expect(resolveImport('.').kind).toBe('local');
  });

  it('identifies Node.js built-ins', () => {
    expect(resolveImport('fs').kind).toBe('builtin');
    expect(resolveImport('path').kind).toBe('builtin');
    expect(resolveImport('node:fs').kind).toBe('builtin');
    expect(resolveImport('node:path').kind).toBe('builtin');
    expect(resolveImport('node:crypto').kind).toBe('builtin');
    expect(resolveImport('os').kind).toBe('builtin');
    expect(resolveImport('events').kind).toBe('builtin');
  });

  it('identifies npm packages', () => {
    expect(resolveImport('react').kind).toBe('package');
    expect(resolveImport('lodash').kind).toBe('package');
    expect(resolveImport('express').kind).toBe('package');
  });

  it('identifies scoped npm packages', () => {
    expect(resolveImport('@babel/parser').kind).toBe('package');
    expect(resolveImport('@types/node').kind).toBe('package');
  });

  it('extracts package name from sub-path imports', () => {
    const result = resolveImport('lodash/merge');
    expect(result.kind).toBe('package');
    expect(result.packageName).toBe('lodash');
  });

  it('preserves scoped package name from sub-path', () => {
    const result = resolveImport('@scope/package/util');
    expect(result.packageName).toBe('@scope/package');
  });
});

describe('extractPackageName', () => {
  it('extracts bare package name', () => {
    expect(extractPackageName('lodash')).toBe('lodash');
    expect(extractPackageName('express')).toBe('express');
  });

  it('extracts scoped package name', () => {
    expect(extractPackageName('@babel/parser')).toBe('@babel/parser');
    expect(extractPackageName('@types/node')).toBe('@types/node');
  });

  it('strips sub-path from unscoped package', () => {
    expect(extractPackageName('lodash/merge')).toBe('lodash');
    expect(extractPackageName('chalk/source/index.js')).toBe('chalk');
  });

  it('strips sub-path from scoped package', () => {
    expect(extractPackageName('@scope/pkg/deep/path')).toBe('@scope/pkg');
  });

  it('handles empty string gracefully', () => {
    expect(() => extractPackageName('')).not.toThrow();
  });
});
