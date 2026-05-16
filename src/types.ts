import type { File as BabelFile } from '@babel/types';

export interface Config {
  ignoreDependencies: string[];
  ignoreVariables: string[];
  ignoreFiles: string[];
  ignorePackages: string[];
  security: boolean;
  fix: boolean;
  maxFileSizeMB: number;
  maxFiles: number;
  maxDepth: number;
  includeDevDependencies: boolean;
  reportFormat: 'terminal' | 'json' | 'markdown';
  outputFile?: string;
}

export interface FileInfo {
  absolutePath: string;
  relativePath: string;
  content: string;
  sizeBytes: number;
}

export interface ImportSpecifierInfo {
  local: string;
  imported: string;
  isDefault: boolean;
  isNamespace: boolean;
  isTypeOnly: boolean;
}

export interface ImportInfo {
  source: string;
  specifiers: ImportSpecifierInfo[];
  isTypeOnly: boolean;
  isDynamic: boolean;
  line: number;
}

export interface ExportInfo {
  name: string;
  isDefault: boolean;
  isReExport: boolean;
  source?: string;
  line: number;
}

export interface VariableInfo {
  name: string;
  kind: 'const' | 'let' | 'var';
  line: number;
  /** True when the declaration is inside a function body (not top-level). */
  inFunction?: boolean;
}

export interface FunctionInfo {
  name: string;
  line: number;
  isExported: boolean;
  isArrow: boolean;
}

export interface ParsedFile {
  path: string;
  ast: BabelFile;
  imports: ImportInfo[];
  exports: ExportInfo[];
  variables: VariableInfo[];
  functions: FunctionInfo[];
  usedIdentifiers: Set<string>;
}

export type DependencyIssueType = 'unused' | 'unused-dev' | 'missing' | 'duplicate';
export type IssueSeverity = 'error' | 'warning' | 'info';
export type SecuritySeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

export interface DependencyIssue {
  type: DependencyIssueType;
  name: string;
  severity: IssueSeverity;
  description: string;
}

export interface ImportIssue {
  type: 'unused-import' | 'unused-specifier';
  file: string;
  line: number;
  source: string;
  specifier?: string;
  severity: IssueSeverity;
  description: string;
}

export interface VariableIssue {
  type: 'unused-variable';
  file: string;
  line: number;
  name: string;
  kind: string;
  severity: IssueSeverity;
  description: string;
}

export interface SecurityIssue {
  type: 'vulnerability' | 'dangerous-script' | 'typosquat';
  package: string;
  severity: SecuritySeverity;
  description: string;
  recommendation?: string;
  via?: string[];
}

export interface EnvIssue {
  type: 'missing' | 'duplicate' | 'invalid-name';
  variable: string;
  file: string;
  line: number;
  severity: IssueSeverity;
  description: string;
}

export interface ScanError {
  file: string;
  message: string;
  phase: 'scan' | 'parse' | 'analyze';
}

export interface ScanResult {
  projectRoot: string;
  filesScanned: number;
  dependencyIssues: DependencyIssue[];
  importIssues: ImportIssue[];
  variableIssues: VariableIssue[];
  securityIssues: SecurityIssue[];
  envIssues: EnvIssue[];
  errors: ScanError[];
  durationMs: number;
}

export type FixActionType = 'remove-import' | 'remove-variable' | 'uninstall-dep';
export type FixConfidence = 'high' | 'medium' | 'low';

export interface FixAction {
  type: FixActionType;
  file?: string;
  line?: number;
  description: string;
  confidence: FixConfidence;
  issueRef: ImportIssue | VariableIssue | DependencyIssue;
}

export interface FixResult {
  applied: FixAction[];
  skipped: FixAction[];
  backupPath: string | null;
  errors: string[];
}

export interface NpmAuditVulnerability {
  name: string;
  severity: string;
  isDirect: boolean;
  via: Array<string | { name: string; severity: string }>;
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
}

export interface NpmAuditResult {
  vulnerabilities: Record<string, NpmAuditVulnerability>;
  metadata: {
    vulnerabilities: {
      info: number;
      low: number;
      moderate: number;
      high: number;
      critical: number;
      total: number;
    };
  };
}
