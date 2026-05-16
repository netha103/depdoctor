import { describe, it, expect } from 'vitest';
import { formatJson } from '../../../src/formatters/json.js';
import { formatMarkdown } from '../../../src/formatters/markdown.js';
import { formatTerminal } from '../../../src/formatters/terminal.js';
import type { ScanResult } from '../../../src/types.js';

const cleanResult: ScanResult = {
  projectRoot: '/project',
  filesScanned: 10,
  dependencyIssues: [],
  importIssues: [],
  variableIssues: [],
  securityIssues: [],
  envIssues: [],
  errors: [],
  durationMs: 42,
};

const resultWithIssues: ScanResult = {
  projectRoot: '/project',
  filesScanned: 20,
  dependencyIssues: [
    { type: 'unused', name: 'lodash', severity: 'warning', description: 'lodash is unused' },
  ],
  importIssues: [
    {
      type: 'unused-import',
      file: '/project/src/index.ts',
      line: 5,
      source: 'chalk',
      severity: 'warning',
      description: 'chalk is unused',
    },
  ],
  variableIssues: [
    {
      type: 'unused-variable',
      file: '/project/src/utils.ts',
      line: 12,
      name: 'tempVar',
      kind: 'const',
      severity: 'warning',
      description: 'tempVar is unused',
    },
  ],
  securityIssues: [
    {
      type: 'vulnerability',
      package: 'express',
      severity: 'high',
      description: 'Prototype Pollution',
      recommendation: 'Upgrade to express@5',
      via: ['express'],
    },
    {
      type: 'typosquat',
      package: 'lodas',
      severity: 'info',
      description: 'Possible typosquat of lodash',
    },
  ],
  envIssues: [],
  errors: [{ file: '/project/src/broken.ts', message: 'Parse error', phase: 'parse' }],
  durationMs: 1234,
};

// ─── JSON formatter ───────────────────────────────────────────────────────────

describe('formatJson', () => {
  it('produces valid JSON', () => {
    const output = formatJson(cleanResult);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('includes filesScanned count', () => {
    const parsed = JSON.parse(formatJson(cleanResult)) as ScanResult;
    expect(parsed.filesScanned).toBe(10);
  });

  it('includes all issue categories', () => {
    const parsed = JSON.parse(formatJson(resultWithIssues)) as Record<string, unknown>;
    expect(parsed['dependencyIssues']).toBeDefined();
    expect(parsed['importIssues']).toBeDefined();
    expect(parsed['variableIssues']).toBeDefined();
    expect(parsed['securityIssues']).toBeDefined();
  });

  it('serializes without crashing on Set fields', () => {
    expect(() => formatJson(cleanResult)).not.toThrow();
  });
});

// ─── Markdown formatter ───────────────────────────────────────────────────────

describe('formatMarkdown', () => {
  it('contains a markdown H1 header', () => {
    const output = formatMarkdown(cleanResult);
    expect(output).toContain('# depdoctor');
  });

  it('contains a summary table', () => {
    const output = formatMarkdown(resultWithIssues);
    expect(output).toContain('| Category |');
  });

  it('lists unused dependency names', () => {
    const output = formatMarkdown(resultWithIssues);
    expect(output).toContain('lodash');
  });

  it('includes security issue package names', () => {
    const output = formatMarkdown(resultWithIssues);
    expect(output).toContain('express');
  });

  it('produces clean output for zero-issue scan', () => {
    const output = formatMarkdown(cleanResult);
    expect(output).toContain('depdoctor');
    expect(output).not.toContain('undefined');
  });

  it('includes scan errors section when errors exist', () => {
    const output = formatMarkdown(resultWithIssues);
    expect(output).toContain('broken.ts');
  });
});

// ─── Terminal formatter ────────────────────────────────────────────────────────

describe('formatTerminal', () => {
  it('returns a non-empty string', () => {
    const output = formatTerminal(cleanResult);
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('includes files scanned count', () => {
    const output = formatTerminal(cleanResult);
    expect(output).toContain('10');
  });

  it('includes dependency issue names (strip ANSI)', () => {
    const raw = formatTerminal(resultWithIssues);
    // Strip ANSI escape codes before asserting
    const stripped = raw.replace(/\x1B\[[0-9;]*m/g, '');
    expect(stripped).toContain('lodash');
  });

  it('includes security issue package names', () => {
    const raw = formatTerminal(resultWithIssues);
    const stripped = raw.replace(/\x1B\[[0-9;]*m/g, '');
    expect(stripped).toContain('express');
  });

  it('does not throw for empty result', () => {
    expect(() => formatTerminal(cleanResult)).not.toThrow();
  });
});
