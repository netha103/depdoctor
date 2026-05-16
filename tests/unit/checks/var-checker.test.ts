import { describe, it, expect } from 'vitest';
import { checkVariables } from '../../../src/checks/variables/var-checker.js';
import type { ParsedFile } from '../../../src/types.js';

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

function makeFile(
  vars: Array<{ name: string; kind: 'const' | 'let' | 'var'; line?: number }>,
  usedIdentifiers: string[],
  exportedNames: string[] = [],
): ParsedFile {
  return {
    path: '/project/src/index.ts',
    ast: {} as never,
    imports: [],
    exports: exportedNames.map((name) => ({ name, isDefault: false, isReExport: false, line: 1 })),
    variables: vars.map((v) => ({ name: v.name, kind: v.kind, line: v.line ?? 1 })),
    functions: [],
    usedIdentifiers: new Set(usedIdentifiers),
  };
}

describe('checkVariables', () => {
  it('flags unused const variable', () => {
    const file = makeFile([{ name: 'unusedVar', kind: 'const' }], []);
    const issues = checkVariables([file], defaultConfig);
    expect(issues.some((i) => i.name === 'unusedVar')).toBe(true);
  });

  it('does not flag used variable', () => {
    const file = makeFile([{ name: 'usedVar', kind: 'const' }], ['usedVar']);
    const issues = checkVariables([file], defaultConfig);
    expect(issues).toHaveLength(0);
  });

  it('does not flag exported variable', () => {
    const file = makeFile([{ name: 'exportedVar', kind: 'const' }], [], ['exportedVar']);
    const issues = checkVariables([file], defaultConfig);
    expect(issues.some((i) => i.name === 'exportedVar')).toBe(false);
  });

  it('skips variables starting with _', () => {
    const file = makeFile([{ name: '_intentional', kind: 'const' }], []);
    const issues = checkVariables([file], defaultConfig);
    expect(issues.some((i) => i.name === '_intentional')).toBe(false);
  });

  it('respects ignoreVariables config', () => {
    const file = makeFile([{ name: 'ignoredVar', kind: 'const' }], []);
    const config = { ...defaultConfig, ignoreVariables: ['ignoredVar'] };
    const issues = checkVariables([file], config);
    expect(issues.some((i) => i.name === 'ignoredVar')).toBe(false);
  });

  it('uses warning severity for const, info for let/var', () => {
    const file = makeFile([
      { name: 'constVar', kind: 'const' },
      { name: 'letVar', kind: 'let' },
      { name: 'varVar', kind: 'var' },
    ], []);
    const issues = checkVariables([file], defaultConfig);
    expect(issues.find((i) => i.name === 'constVar')?.severity).toBe('warning');
    expect(issues.find((i) => i.name === 'letVar')?.severity).toBe('info');
    expect(issues.find((i) => i.name === 'varVar')?.severity).toBe('info');
  });

  it('handles multiple files independently', () => {
    const file1 = makeFile([{ name: 'a', kind: 'const' }], []);
    const file2 = makeFile([{ name: 'b', kind: 'const' }], ['b']);
    file2.path = '/project/src/other.ts';
    const issues = checkVariables([file1, file2], defaultConfig);
    expect(issues.some((i) => i.name === 'a')).toBe(true);
    expect(issues.some((i) => i.name === 'b')).toBe(false);
  });
});
