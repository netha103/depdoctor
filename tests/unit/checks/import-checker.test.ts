import { describe, it, expect } from 'vitest';
import { checkImports } from '../../../src/checks/imports/import-checker.js';
import type { ParsedFile } from '../../../src/types.js';

function makeFile(
  filePath: string,
  imports: Array<{ source: string; locals: string[]; isTypeOnly?: boolean; isDynamic?: boolean }>,
  usedIdentifiers: string[],
): ParsedFile {
  return {
    path: filePath,
    ast: {} as never,
    imports: imports.map((imp, i) => ({
      source: imp.source,
      specifiers: imp.locals.map((local) => ({
        local,
        imported: local,
        isDefault: false,
        isNamespace: false,
        isTypeOnly: imp.isTypeOnly ?? false,
      })),
      isTypeOnly: imp.isTypeOnly ?? false,
      isDynamic: imp.isDynamic ?? false,
      line: i + 1,
    })),
    exports: [],
    variables: [],
    functions: [],
    usedIdentifiers: new Set(usedIdentifiers),
  };
}

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

describe('checkImports', () => {
  it('flags fully unused import', () => {
    const file = makeFile('/project/src/index.ts', [{ source: 'lodash', locals: ['debounce'] }], []);
    const issues = checkImports([file], defaultConfig);
    expect(issues.some((i) => i.type === 'unused-import' && i.source === 'lodash')).toBe(true);
  });

  it('does not flag used import', () => {
    const file = makeFile('/project/src/index.ts', [{ source: 'lodash', locals: ['debounce'] }], ['debounce']);
    const issues = checkImports([file], defaultConfig);
    expect(issues).toHaveLength(0);
  });

  it('flags only unused specifiers when import is partially used', () => {
    const file = makeFile(
      '/project/src/index.ts',
      [{ source: 'react', locals: ['useState', 'useEffect'] }],
      ['useState'], // useEffect NOT used
    );
    const issues = checkImports([file], defaultConfig);
    expect(issues.some((i) => i.specifier === 'useEffect' && i.type === 'unused-specifier')).toBe(true);
    expect(issues.some((i) => i.specifier === 'useState')).toBe(false);
  });

  it('does not flag side-effect imports (no specifiers)', () => {
    const file = makeFile('/project/src/polyfills.ts', [{ source: 'reflect-metadata', locals: [] }], []);
    const issues = checkImports([file], defaultConfig);
    expect(issues).toHaveLength(0);
  });

  it('skips _ prefixed identifiers', () => {
    const file = makeFile('/project/src/index.ts', [{ source: 'util', locals: ['_unused'] }], []);
    const issues = checkImports([file], defaultConfig);
    expect(issues.some((i) => i.specifier === '_unused')).toBe(false);
  });

  it('respects ignoreVariables config', () => {
    const file = makeFile('/project/src/index.ts', [{ source: 'lodash', locals: ['debounce'] }], []);
    const config = { ...defaultConfig, ignoreVariables: ['debounce'] };
    const issues = checkImports([file], config);
    expect(issues.some((i) => i.specifier === 'debounce')).toBe(false);
  });

  it('handles namespace imports', () => {
    const file: ParsedFile = {
      path: '/project/src/index.ts',
      ast: {} as never,
      imports: [{
        source: 'path',
        specifiers: [{ local: 'pathUtils', imported: '*', isDefault: false, isNamespace: true, isTypeOnly: false }],
        isTypeOnly: false,
        isDynamic: false,
        line: 1,
      }],
      exports: [],
      variables: [],
      functions: [],
      usedIdentifiers: new Set<string>(), // pathUtils NOT used
    };
    const issues = checkImports([file], defaultConfig);
    expect(issues.some((i) => i.type === 'unused-import')).toBe(true);
  });

  it('does not flag namespace import when it is used', () => {
    const file: ParsedFile = {
      path: '/project/src/index.ts',
      ast: {} as never,
      imports: [{
        source: 'path',
        specifiers: [{ local: 'pathUtils', imported: '*', isDefault: false, isNamespace: true, isTypeOnly: false }],
        isTypeOnly: false,
        isDynamic: false,
        line: 1,
      }],
      exports: [],
      variables: [],
      functions: [],
      usedIdentifiers: new Set(['pathUtils']),
    };
    const issues = checkImports([file], defaultConfig);
    expect(issues).toHaveLength(0);
  });

  it('returns info severity for type-only unused imports', () => {
    const file = makeFile('/project/src/index.ts', [{ source: './types', locals: ['Config'], isTypeOnly: true }], []);
    const issues = checkImports([file], defaultConfig);
    const issue = issues.find((i) => i.source === './types');
    expect(issue?.severity).toBe('info');
  });
});
