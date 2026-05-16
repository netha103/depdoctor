/**
 * JSON formatter — serialises a `ScanResult` to a JSON string.
 *
 * `ParsedFile.usedIdentifiers` is a `Set<string>` which is not JSON-
 * serialisable by default.  Because `ScanResult` itself does not contain
 * `ParsedFile` objects, this is not an issue for the top-level result object.
 *
 * However, if any future field were to embed a `Set`, `JSON.stringify` would
 * silently emit `{}` for it.  A custom replacer is used to convert any `Set`
 * encountered during serialisation into a sorted array, making the output both
 * correct and deterministic.
 */

import type { ScanResult } from '../types.js';

/**
 * A JSON.stringify replacer that converts `Set` instances to sorted arrays so
 * they serialise correctly.  All other values pass through unchanged.
 */
function setAwareReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) {
    return [...value].sort();
  }
  return value;
}

/**
 * Serialise `result` to a 2-space-indented JSON string.
 *
 * Any `Set` fields are converted to sorted arrays.  The result is valid JSON
 * that can be written to a file, piped to `jq`, or consumed programmatically.
 */
export function formatJson(result: ScanResult): string {
  return JSON.stringify(result, setAwareReplacer, 2);
}
