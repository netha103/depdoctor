import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../types.js';
import { logger } from '../utils/logger.js';
import { resolveWithinRoot, safeStat } from '../utils/path-safety.js';

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: Readonly<Config> = {
  ignoreDependencies: [],
  ignoreVariables: [],
  ignoreFiles: [],
  ignorePackages: [],
  security: true,
  fix: false,
  maxFileSizeMB: 10,
  maxFiles: 10_000,
  maxDepth: 20,
  includeDevDependencies: true,
  reportFormat: 'terminal',
};

// ---------------------------------------------------------------------------
// Candidate config file names (tried in order)
// ---------------------------------------------------------------------------

const CONFIG_FILE_NAMES = ['.depdoctorrc', '.depdoctorrc.json'] as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isReportFormat(value: unknown): value is Config['reportFormat'] {
  return value === 'terminal' || value === 'json' || value === 'markdown';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a raw parsed object and return a partial `Config` containing only
 * the keys that are present and valid.  Unknown keys are silently ignored;
 * invalid values for known keys emit a warning and fall back to the default.
 */
function validateRawConfig(raw: Record<string, unknown>): Partial<Config> {
  const partial: Partial<Config> = {};

  const assertStringArray = (key: keyof Config, label: string): string[] | undefined => {
    if (!(key in raw)) return undefined;
    if (isStringArray(raw[key])) return raw[key] as string[];
    logger.warn(`Config: "${label}" must be an array of strings — using default.`);
    return undefined;
  };

  const assertBoolean = (key: keyof Config, label: string): boolean | undefined => {
    if (!(key in raw)) return undefined;
    if (typeof raw[key] === 'boolean') return raw[key] as boolean;
    logger.warn(`Config: "${label}" must be a boolean — using default.`);
    return undefined;
  };

  const assertPositiveNumber = (key: keyof Config, label: string): number | undefined => {
    if (!(key in raw)) return undefined;
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    logger.warn(`Config: "${label}" must be a positive number — using default.`);
    return undefined;
  };

  // String arrays
  const ignoreDependencies = assertStringArray('ignoreDependencies', 'ignoreDependencies');
  if (ignoreDependencies !== undefined) partial.ignoreDependencies = ignoreDependencies;

  const ignoreVariables = assertStringArray('ignoreVariables', 'ignoreVariables');
  if (ignoreVariables !== undefined) partial.ignoreVariables = ignoreVariables;

  const ignoreFiles = assertStringArray('ignoreFiles', 'ignoreFiles');
  if (ignoreFiles !== undefined) partial.ignoreFiles = ignoreFiles;

  const ignorePackages = assertStringArray('ignorePackages', 'ignorePackages');
  if (ignorePackages !== undefined) partial.ignorePackages = ignorePackages;

  // Booleans
  const security = assertBoolean('security', 'security');
  if (security !== undefined) partial.security = security;

  const fix = assertBoolean('fix', 'fix');
  if (fix !== undefined) partial.fix = fix;

  const includeDevDependencies = assertBoolean('includeDevDependencies', 'includeDevDependencies');
  if (includeDevDependencies !== undefined) partial.includeDevDependencies = includeDevDependencies;

  // Positive numbers
  const maxFileSizeMB = assertPositiveNumber('maxFileSizeMB', 'maxFileSizeMB');
  if (maxFileSizeMB !== undefined) partial.maxFileSizeMB = maxFileSizeMB;

  const maxFiles = assertPositiveNumber('maxFiles', 'maxFiles');
  if (maxFiles !== undefined) partial.maxFiles = Math.floor(maxFiles);

  const maxDepth = assertPositiveNumber('maxDepth', 'maxDepth');
  if (maxDepth !== undefined) partial.maxDepth = Math.floor(maxDepth);

  // reportFormat enum
  if ('reportFormat' in raw) {
    if (isReportFormat(raw['reportFormat'])) {
      partial.reportFormat = raw['reportFormat'];
    } else {
      logger.warn(
        `Config: "reportFormat" must be one of 'terminal', 'json', 'markdown' — using default.`,
      );
    }
  }

  // Optional outputFile
  if ('outputFile' in raw) {
    if (typeof raw['outputFile'] === 'string' && raw['outputFile'].length > 0) {
      partial.outputFile = raw['outputFile'];
    } else {
      logger.warn(`Config: "outputFile" must be a non-empty string — ignoring.`);
    }
  }

  return partial;
}

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to read and parse a JSON config file at `filePath`.
 *
 * Returns the raw parsed object on success, or `null` if the file cannot be
 * read or is not valid JSON.
 */
function readJsonConfig(filePath: string): Record<string, unknown> | null {
  let raw: string;

  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Config: failed to parse "${filePath}" as JSON — ${message}. Using defaults.`);
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn(
      `Config: "${filePath}" must be a JSON object at the top level — using defaults.`,
    );
    return null;
  }

  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the depdoctor configuration for a project.
 *
 * 1. Look for `.depdoctorrc` then `.depdoctorrc.json` inside `projectRoot`.
 * 2. Parse and validate the JSON content.
 * 3. Deep-merge with `DEFAULT_CONFIG` (file values take precedence).
 * 4. Return the fully-resolved `Config` object.
 *
 * Path-traversal is prevented: config files are only accepted when they
 * resolve to a path that is strictly inside `projectRoot`.
 */
export function loadConfig(projectRoot: string): Config {
  const resolvedRoot = path.resolve(projectRoot);

  const stat = safeStat(resolvedRoot);
  if (!stat?.isDirectory()) {
    logger.warn(`Config: projectRoot "${projectRoot}" is not a directory — using defaults.`);
    return { ...DEFAULT_CONFIG };
  }

  for (const name of CONFIG_FILE_NAMES) {
    const candidate = resolveWithinRoot(resolvedRoot, name);

    // resolveWithinRoot returns null when the path would escape the root
    if (candidate === null) {
      logger.debug(`Config: skipping "${name}" — path resolves outside root.`);
      continue;
    }

    const fileStat = safeStat(candidate);
    if (!fileStat?.isFile()) {
      logger.debug(`Config: "${name}" not found at "${candidate}".`);
      continue;
    }

    logger.debug(`Config: loading from "${candidate}".`);
    const rawObject = readJsonConfig(candidate);

    if (rawObject === null) {
      // Warning already emitted inside readJsonConfig
      return { ...DEFAULT_CONFIG };
    }

    const validated = validateRawConfig(rawObject);

    const merged: Config = {
      ...DEFAULT_CONFIG,
      ...validated,
    };

    logger.debug(`Config: loaded successfully from "${name}".`);
    return merged;
  }

  logger.debug('Config: no config file found — using defaults.');
  return { ...DEFAULT_CONFIG };
}
