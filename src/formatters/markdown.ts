/**
 * Markdown formatter — renders a `ScanResult` as a GitHub-Flavored Markdown
 * report suitable for filing as a PR comment, wiki page, or standalone file.
 */

import type {
  ScanResult,
  DependencyIssue,
  ImportIssue,
  VariableIssue,
  SecurityIssue,
  EnvIssue,
  SecuritySeverity,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape pipe characters so they don't break GFM table cells. */
function escMd(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/`/g, "'");
}

function secSeverityEmoji(sev: SecuritySeverity): string {
  switch (sev) {
    case 'critical': return '🔴';
    case 'high':     return '🟠';
    case 'moderate': return '🟡';
    case 'low':      return '🟢';
    case 'info':     return '🔵';
  }
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildSummaryTable(result: ScanResult): string {
  const rows: Array<[string, number]> = [
    ['Unused Dependencies', result.dependencyIssues.length],
    ['Unused Imports',      result.importIssues.length],
    ['Unused Variables',    result.variableIssues.length],
    ['Security Issues',     result.securityIssues.length],
    ['Env Variable Issues', result.envIssues.length],
  ];

  const tableLines: string[] = [
    '## Summary',
    '',
    '| Category | Count |',
    '|----------|------:|',
  ];

  for (const [label, count] of rows) {
    tableLines.push(`| ${label} | ${count} |`);
  }

  const total =
    result.dependencyIssues.length +
    result.importIssues.length +
    result.variableIssues.length +
    result.securityIssues.length +
    result.envIssues.length;

  tableLines.push(`| **Total** | **${total}** |`);

  return tableLines.join('\n');
}

function buildDependencySection(issues: DependencyIssue[]): string {
  if (issues.length === 0) return '';

  const lines: string[] = [
    '## Unused Dependencies',
    '',
    `> ${issues.length} package(s) listed in \`package.json\` are not imported anywhere.`,
    '',
    '| Package | Type | Severity | Description |',
    '|---------|------|----------|-------------|',
  ];

  for (const issue of issues) {
    lines.push(
      `| \`${escMd(issue.name)}\` | ${issue.type} | ${issue.severity} | ${escMd(issue.description)} |`,
    );
  }

  return lines.join('\n');
}

function buildImportSection(issues: ImportIssue[]): string {
  if (issues.length === 0) return '';

  const lines: string[] = [
    '## Unused Imports',
    '',
    '| File | Line | Source | Specifier | Severity | Description |',
    '|------|-----:|--------|-----------|----------|-------------|',
  ];

  for (const issue of issues) {
    const specifier = issue.specifier !== undefined ? `\`${escMd(issue.specifier)}\`` : '—';
    lines.push(
      `| \`${escMd(issue.file)}\` | ${issue.line} | \`${escMd(issue.source)}\` | ${specifier} | ${issue.severity} | ${escMd(issue.description)} |`,
    );
  }

  return lines.join('\n');
}

function buildVariableSection(issues: VariableIssue[]): string {
  if (issues.length === 0) return '';

  const lines: string[] = [
    '## Unused Variables',
    '',
    '| File | Line | Name | Kind | Severity | Description |',
    '|------|-----:|------|------|----------|-------------|',
  ];

  for (const issue of issues) {
    lines.push(
      `| \`${escMd(issue.file)}\` | ${issue.line} | \`${escMd(issue.name)}\` | \`${issue.kind}\` | ${issue.severity} | ${escMd(issue.description)} |`,
    );
  }

  return lines.join('\n');
}

function buildSecuritySection(issues: SecurityIssue[]): string {
  if (issues.length === 0) return '';

  const sections: string[] = ['## Security Issues', ''];

  // Group by severity.
  const order: SecuritySeverity[] = ['critical', 'high', 'moderate', 'low', 'info'];
  const grouped = new Map<SecuritySeverity, SecurityIssue[]>();
  for (const sev of order) grouped.set(sev, []);
  for (const issue of issues) {
    grouped.get(issue.severity)?.push(issue);
  }

  for (const sev of order) {
    const group = grouped.get(sev) ?? [];
    if (group.length === 0) continue;

    const emoji = secSeverityEmoji(sev);
    sections.push(`### ${emoji} ${sev.charAt(0).toUpperCase() + sev.slice(1)}`);
    sections.push('');

    for (const issue of group) {
      sections.push(`- **\`${escMd(issue.package)}\`** (${issue.type}) — ${escMd(issue.description)}`);
      if (issue.via !== undefined && issue.via.length > 0) {
        sections.push(`  - Via: ${issue.via.map((v) => `\`${escMd(v)}\``).join(', ')}`);
      }
      if (issue.recommendation !== undefined) {
        sections.push(`  - Recommendation: _${escMd(issue.recommendation)}_`);
      }
    }

    sections.push('');
  }

  return sections.join('\n');
}

function buildEnvSection(issues: EnvIssue[]): string {
  if (issues.length === 0) return '';

  const lines: string[] = [
    '## Environment Variable Issues',
    '',
    '| Variable | File | Line | Type | Severity | Description |',
    '|----------|------|-----:|------|----------|-------------|',
  ];

  for (const issue of issues) {
    lines.push(
      `| \`${escMd(issue.variable)}\` | \`${escMd(issue.file)}\` | ${issue.line} | ${issue.type} | ${issue.severity} | ${escMd(issue.description)} |`,
    );
  }

  return lines.join('\n');
}

function buildErrorsSection(errors: ScanResult['errors']): string {
  if (errors.length === 0) return '';

  const lines: string[] = [
    '## Scan / Parse Errors',
    '',
    `> ${errors.length} error(s) occurred during scanning or parsing. These files were skipped.`,
    '',
    '| File | Phase | Message |',
    '|------|-------|---------|',
  ];

  for (const err of errors) {
    lines.push(`| \`${escMd(err.file)}\` | ${err.phase} | ${escMd(err.message)} |`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render `result` as a GitHub-Flavored Markdown string.
 */
export function formatMarkdown(result: ScanResult): string {
  const totalIssues =
    result.dependencyIssues.length +
    result.importIssues.length +
    result.variableIssues.length +
    result.securityIssues.length +
    result.envIssues.length;

  const statusLine =
    totalIssues === 0
      ? '> ✅ **No issues found.**'
      : `> ⚠️ **${totalIssues} issue(s) found** across ${result.filesScanned} scanned file(s).`;

  const sections: string[] = [
    '# depdoctor Report',
    '',
    statusLine,
    '',
    `**Project:** \`${result.projectRoot}\`  `,
    `**Scanned:** ${result.filesScanned} file(s) in ${result.durationMs}ms  `,
    `**Date:** ${new Date().toISOString()}`,
    '',
    buildSummaryTable(result),
    '',
    buildDependencySection(result.dependencyIssues),
    buildImportSection(result.importIssues),
    buildVariableSection(result.variableIssues),
    buildSecuritySection(result.securityIssues),
    buildEnvSection(result.envIssues),
    buildErrorsSection(result.errors),
  ];

  // Remove consecutive blank lines left by empty sections.
  const output = sections
    .filter((s) => s !== '')
    .join('\n');

  return output + '\n';
}
