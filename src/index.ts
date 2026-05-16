/**
 * depdoctor public API.
 *
 * Re-exports the main entry points so library consumers can do:
 *   import { analyzeProject, loadConfig, formatTerminal, applyFixes } from 'depdoctor';
 */

export { analyzeProject } from './core/analyzer/project-analyzer.js';
export { loadConfig } from './config/loader.js';
export { formatTerminal, formatJson, formatMarkdown } from './formatters/index.js';
export { applyFixes } from './fixers/fix-engine.js';
export type * from './types.js';
