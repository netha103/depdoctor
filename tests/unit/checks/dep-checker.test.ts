import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { checkDependencies } from '../../../src/checks/dependency/dep-checker.js';
import { loadConfig } from '../../../src/config/loader.js';
import type { ParsedFile } from '../../../src/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depdoctor-dep-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makePkg(deps: Record<string, string>, devDeps: Record<string, string> = {}) {
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ name: 'test', dependencies: deps, devDependencies: devDeps }),
  );
}

function makeParsedFile(imports: string[]): ParsedFile {
  return {
    path: path.join(tmpDir, 'src/index.ts'),
    ast: {} as never,
    imports: imports.map((src) => ({
      source: src,
      specifiers: [{ local: 'x', imported: 'x', isDefault: false, isNamespace: false, isTypeOnly: false }],
      isTypeOnly: false,
      isDynamic: false,
      line: 1,
    })),
    exports: [],
    variables: [],
    functions: [],
    usedIdentifiers: new Set(['x']),
  };
}

describe('checkDependencies', () => {
  it('flags unused production dependencies', () => {
    makePkg({ lodash: '^4.0.0', express: '^4.0.0' });
    const files = [makeParsedFile(['express'])]; // lodash NOT imported
    const config = loadConfig(tmpDir);
    const issues = checkDependencies(tmpDir, files, config);
    expect(issues.some((i) => i.name === 'lodash' && i.type === 'unused')).toBe(true);
    expect(issues.some((i) => i.name === 'express')).toBe(false);
  });

  it('does not flag used dependencies', () => {
    makePkg({ axios: '^1.0.0' });
    const files = [makeParsedFile(['axios'])];
    const config = loadConfig(tmpDir);
    const issues = checkDependencies(tmpDir, files, config);
    expect(issues.some((i) => i.name === 'axios')).toBe(false);
  });

  it('respects ignoreDependencies config', () => {
    makePkg({ moment: '^2.0.0' });
    const files = [makeParsedFile([])];
    const config = { ...loadConfig(tmpDir), ignoreDependencies: ['moment'] };
    const issues = checkDependencies(tmpDir, files, config);
    expect(issues.some((i) => i.name === 'moment')).toBe(false);
  });

  it('does not flag build tools like typescript and eslint', () => {
    makePkg({}, { typescript: '^5.0.0', eslint: '^8.0.0', vitest: '^1.0.0' });
    const files = [makeParsedFile([])];
    const config = loadConfig(tmpDir);
    const issues = checkDependencies(tmpDir, files, config);
    expect(issues.some((i) => i.name === 'typescript')).toBe(false);
    expect(issues.some((i) => i.name === 'eslint')).toBe(false);
    expect(issues.some((i) => i.name === 'vitest')).toBe(false);
  });

  it('handles sub-path imports correctly — lodash/merge counts as using lodash', () => {
    makePkg({ lodash: '^4.0.0' });
    const files = [makeParsedFile(['lodash/merge'])];
    const config = loadConfig(tmpDir);
    const issues = checkDependencies(tmpDir, files, config);
    expect(issues.some((i) => i.name === 'lodash')).toBe(false);
  });

  it('handles scoped packages', () => {
    makePkg({ '@scope/pkg': '^1.0.0' });
    const files = [makeParsedFile(['@scope/pkg'])];
    const config = loadConfig(tmpDir);
    const issues = checkDependencies(tmpDir, files, config);
    expect(issues.some((i) => i.name === '@scope/pkg')).toBe(false);
  });

  it('returns empty array when no package.json exists', () => {
    const config = loadConfig(tmpDir);
    expect(() => checkDependencies(tmpDir, [], config)).not.toThrow();
  });

  it('uses warning severity for unused prod dep, info for unused devDep', () => {
    // uuid is a real utility package — not in the build-tools exclusion list
    makePkg({ lodash: '^4.0.0' }, { uuid: '^9.0.0' });
    const files = [makeParsedFile([])];
    const config = loadConfig(tmpDir);
    const issues = checkDependencies(tmpDir, files, config);
    const lodashIssue = issues.find((i) => i.name === 'lodash');
    const uuidIssue = issues.find((i) => i.name === 'uuid');
    expect(lodashIssue?.severity).toBe('warning');
    expect(uuidIssue?.severity).toBe('info');
  });
});
