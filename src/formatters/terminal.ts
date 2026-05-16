/**
 * Terminal formatter — renders a `ScanResult` as a human-readable, chalk-
 * coloured string suitable for printing to a terminal.
 *
 * Color scheme:
 *  - chalk.red      critical / error severity
 *  - chalk.yellow   warning severity
 *  - chalk.cyan     info severity / section headers
 *  - chalk.green    success / no-issues message
 *  - chalk.blue     file paths
 *  - chalk.gray     line numbers, muted details
 *  - chalk.magenta  package / specifier names
 */

import chalk, { type ChalkInstance } from 'chalk';
import type {
  ScanResult,
  DependencyIssue,
  ImportIssue,
  VariableIssue,
  SecurityIssue,
  EnvIssue,
  IssueSeverity,
  SecuritySeverity,
} from '../types.js';

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

function secSeverityColor(sev: SecuritySeverity): ChalkInstance {
  switch (sev) {
    case 'critical': return chalk.red;
    case 'high':     return chalk.red;
    case 'moderate': return chalk.yellow;
    case 'low':      return chalk.yellow;
    case 'info':     return chalk.cyan;
  }
}

function severityIcon(sev: IssueSeverity): string {
  switch (sev) {
    case 'error':   return chalk.red('❌');
    case 'warning': return chalk.yellow('⚠');
    case 'info':    return chalk.cyan('ℹ');
  }
}

function secSeverityIcon(sev: SecuritySeverity): string {
  switch (sev) {
    case 'critical':
    case 'high':
      return chalk.red('❌');
    case 'moderate':
    case 'low':
      return chalk.yellow('⚠');
    case 'info':
      return chalk.cyan('ℹ');
  }
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderSectionHeader(title: string, count: number): string {
  return (
    '\n' +
    chalk.bold.cyan(title) +
    chalk.gray(` (${count})`) +
    '\n' +
    chalk.gray('─'.repeat(Math.min(title.length + String(count).length + 3, 72)))
  );
}

function renderDependencyIssues(issues: DependencyIssue[]): string {
  if (issues.length === 0) return '';

  const lines: string[] = [renderSectionHeader('Unused Dependencies', issues.length)];

  for (const issue of issues) {
    const icon = severityIcon(issue.severity);
    const nameStr = chalk.magenta(issue.name.padEnd(30));
    const typeLabel = chalk.gray(`[${issue.type}]`);
    lines.push(`  ${icon} ${nameStr} ${typeLabel} — ${issue.description}`);
  }

  return lines.join('\n');
}

function renderImportIssues(issues: ImportIssue[]): string {
  if (issues.length === 0) return '';

  const lines: string[] = [renderSectionHeader('Unused Imports', issues.length)];

  for (const issue of issues) {
    const icon = severityIcon(issue.severity);
    const loc = chalk.blue(issue.file) + chalk.gray(`:${issue.line}`);
    const srcStr = chalk.magenta(`'${issue.source}'`);

    if (issue.type === 'unused-specifier' && issue.specifier !== undefined) {
      const specStr = chalk.yellow(issue.specifier);
      lines.push(`  ${icon} ${loc}  ${specStr} from ${srcStr} — ${issue.description}`);
    } else {
      lines.push(`  ${icon} ${loc}  import from ${srcStr} — ${issue.description}`);
    }
  }

  return lines.join('\n');
}

function renderVariableIssues(issues: VariableIssue[]): string {
  if (issues.length === 0) return '';

  const lines: string[] = [renderSectionHeader('Unused Variables', issues.length)];

  for (const issue of issues) {
    const icon = severityIcon(issue.severity);
    const loc = chalk.blue(issue.file) + chalk.gray(`:${issue.line}`);
    const nameStr = chalk.yellow(`${issue.kind} ${issue.name}`);
    lines.push(`  ${icon} ${loc}  ${nameStr} — ${issue.description}`);
  }

  return lines.join('\n');
}

function renderSecurityIssues(issues: SecurityIssue[]): string {
  if (issues.length === 0) return '';

  const lines: string[] = [renderSectionHeader('Security Issues', issues.length)];

  // Group by severity for visual clarity.
  const order: SecuritySeverity[] = ['critical', 'high', 'moderate', 'low', 'info'];
  const grouped = new Map<SecuritySeverity, SecurityIssue[]>();
  for (const sev of order) grouped.set(sev, []);
  for (const issue of issues) {
    grouped.get(issue.severity)?.push(issue);
  }

  for (const sev of order) {
    const group = grouped.get(sev) ?? [];
    if (group.length === 0) continue;

    lines.push('  ' + chalk.bold(sev.toUpperCase()));
    for (const issue of group) {
      const icon = secSeverityIcon(issue.severity);
      const pkgStr = chalk.magenta(issue.package.padEnd(24));
      const sevStr = secSeverityColor(issue.severity)(sev.padEnd(10));
      let line = `    ${icon} ${pkgStr} ${sevStr} — ${issue.description}`;
      if (issue.recommendation !== undefined) {
        line += '\n' + chalk.gray(`         Recommendation: ${issue.recommendation}`);
      }
      if (issue.via !== undefined && issue.via.length > 0) {
        line += '\n' + chalk.gray(`         Via: ${issue.via.join(', ')}`);
      }
      lines.push(line);
    }
  }

  return lines.join('\n');
}

function renderEnvIssues(issues: EnvIssue[]): string {
  if (issues.length === 0) return '';

  const lines: string[] = [renderSectionHeader('Environment Variable Issues', issues.length)];

  for (const issue of issues) {
    const icon = severityIcon(issue.severity);
    const loc = chalk.blue(issue.file) + chalk.gray(`:${issue.line}`);
    const varStr = chalk.magenta(issue.variable);
    const typeLabel = chalk.gray(`[${issue.type}]`);
    lines.push(`  ${icon} ${loc}  ${varStr} ${typeLabel} — ${issue.description}`);
  }

  return lines.join('\n');
}

function renderErrors(errors: ScanResult['errors']): string {
  if (errors.length === 0) return '';

  const lines: string[] = [
    '\n' + chalk.bold.red(`Parse / Scan Errors (${errors.length})`) + '\n' + chalk.gray('─'.repeat(40)),
  ];

  for (const err of errors) {
    const phaseLabel = chalk.gray(`[${err.phase}]`);
    const fileStr = chalk.blue(err.file);
    lines.push(`  ${chalk.red('✖')} ${fileStr} ${phaseLabel} ${err.message}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render `result` as a coloured terminal string.
 * The returned string may be passed directly to `process.stdout.write` or
 * `console.log`.
 */
export function formatTerminal(result: ScanResult): string {
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push('');
  lines.push(chalk.bold.white('depdoctor') + chalk.gray(' — dependency & code health report'));
  lines.push(chalk.gray('═'.repeat(60)));
  lines.push(
    chalk.gray('Project:  ') + chalk.blue(result.projectRoot),
  );
  lines.push(
    chalk.gray('Scanned:  ') +
      chalk.white(String(result.filesScanned)) +
      chalk.gray(` file(s) in `) +
      chalk.white(`${result.durationMs}ms`),
  );

  // ── Issue sections (only rendered when non-empty) ─────────────────────────
  lines.push(renderDependencyIssues(result.dependencyIssues));
  lines.push(renderImportIssues(result.importIssues));
  lines.push(renderVariableIssues(result.variableIssues));
  lines.push(renderSecurityIssues(result.securityIssues));
  lines.push(renderEnvIssues(result.envIssues));

  // ── Errors section ────────────────────────────────────────────────────────
  lines.push(renderErrors(result.errors));

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalIssues =
    result.dependencyIssues.length +
    result.importIssues.length +
    result.variableIssues.length +
    result.securityIssues.length +
    result.envIssues.length;

  lines.push('');
  lines.push(chalk.gray('─'.repeat(60)));

  if (totalIssues === 0) {
    lines.push(chalk.green('✔') + chalk.bold.green(' No issues found.'));
  } else {
    const errorCount = [
      ...result.dependencyIssues,
      ...result.importIssues,
      ...result.variableIssues,
    ].filter((i) => i.severity === 'error').length;

    const secCritical = result.securityIssues.filter(
      (i) => i.severity === 'critical' || i.severity === 'high',
    ).length;

    const hasHighSeverity = errorCount > 0 || secCritical > 0;
    const summaryIcon = hasHighSeverity ? chalk.red('❌') : chalk.yellow('⚠');

    lines.push(`${summaryIcon} ${chalk.bold(`${totalIssues} issue(s) found`)}`);

    if (result.dependencyIssues.length > 0) {
      lines.push(
        chalk.gray(`  • Unused dependencies: `) +
          chalk.white(String(result.dependencyIssues.length)),
      );
    }
    if (result.importIssues.length > 0) {
      lines.push(
        chalk.gray(`  • Unused imports:      `) +
          chalk.white(String(result.importIssues.length)),
      );
    }
    if (result.variableIssues.length > 0) {
      lines.push(
        chalk.gray(`  • Unused variables:    `) +
          chalk.white(String(result.variableIssues.length)),
      );
    }
    if (result.securityIssues.length > 0) {
      lines.push(
        chalk.gray(`  • Security issues:     `) +
          chalk.white(String(result.securityIssues.length)),
      );
    }
    if (result.envIssues.length > 0) {
      lines.push(
        chalk.gray(`  • Env issues:          `) +
          chalk.white(String(result.envIssues.length)),
      );
    }
  }

  lines.push('');

  // Filter out empty strings from sections with no issues.
  return lines.filter((l) => l !== '').join('\n');
}
