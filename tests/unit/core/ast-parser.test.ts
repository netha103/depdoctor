import { describe, it, expect } from 'vitest';
import { parseFile } from '../../../src/core/parser/ast-parser.js';

describe('parseFile', () => {
  // ── Basic parsing ──────────────────────────────────────────────────────────

  it('parses a simple TypeScript file', () => {
    const result = parseFile('test.ts', `
      import { useState } from 'react';
      const x: number = 1;
    `);
    expect(result).not.toBeNull();
  });

  it('returns null for completely unparseable content', () => {
    const result = parseFile('bad.ts', '<<< INVALID SYNTAX ??? >>>');
    expect(result).toBeNull();
  });

  it('does not throw on malformed input', () => {
    expect(() => parseFile('broken.ts', '{{{{{{ broken }')).not.toThrow();
  });

  // ── Import extraction ──────────────────────────────────────────────────────

  it('extracts named imports', () => {
    const result = parseFile('test.ts', `import { useState, useEffect } from 'react';`);
    expect(result).not.toBeNull();
    expect(result!.imports).toHaveLength(1);
    const imp = result!.imports[0]!;
    expect(imp.source).toBe('react');
    expect(imp.specifiers).toHaveLength(2);
    expect(imp.specifiers.map((s) => s.local)).toContain('useState');
    expect(imp.specifiers.map((s) => s.local)).toContain('useEffect');
  });

  it('extracts default imports', () => {
    const result = parseFile('test.ts', `import React from 'react';`);
    expect(result!.imports[0]!.specifiers[0]!.isDefault).toBe(true);
    expect(result!.imports[0]!.specifiers[0]!.local).toBe('React');
  });

  it('extracts namespace imports', () => {
    const result = parseFile('test.ts', `import * as path from 'node:path';`);
    const spec = result!.imports[0]!.specifiers[0]!;
    expect(spec.isNamespace).toBe(true);
    expect(spec.local).toBe('path');
  });

  it('extracts type-only imports', () => {
    const result = parseFile('test.ts', `import type { Config } from './config';`);
    expect(result!.imports[0]!.isTypeOnly).toBe(true);
  });

  it('handles side-effect imports (no specifiers)', () => {
    const result = parseFile('test.ts', `import 'reflect-metadata';`);
    expect(result!.imports[0]!.specifiers).toHaveLength(0);
    expect(result!.imports[0]!.source).toBe('reflect-metadata');
  });

  it('extracts dynamic imports', () => {
    const result = parseFile('test.ts', `const mod = import('some-module');`);
    const dynImport = result!.imports.find((i) => i.isDynamic);
    expect(dynImport).toBeDefined();
    expect(dynImport!.source).toBe('some-module');
  });

  it('extracts require() calls', () => {
    const result = parseFile('test.js', `const fs = require('node:fs');`);
    const reqImport = result!.imports.find((i) => i.source === 'node:fs');
    expect(reqImport).toBeDefined();
  });

  // ── Variable extraction ───────────────────────────────────────────────────

  it('extracts const declarations', () => {
    const result = parseFile('test.ts', `const myVar = 42;`);
    expect(result!.variables.some((v) => v.name === 'myVar' && v.kind === 'const')).toBe(true);
  });

  it('extracts let and var declarations', () => {
    const result = parseFile('test.ts', `let a = 1; var b = 2;`);
    expect(result!.variables.some((v) => v.name === 'a' && v.kind === 'let')).toBe(true);
    expect(result!.variables.some((v) => v.name === 'b' && v.kind === 'var')).toBe(true);
  });

  // ── Export extraction ─────────────────────────────────────────────────────

  it('extracts named exports', () => {
    const result = parseFile('test.ts', `export const helper = () => {};`);
    expect(result!.exports.some((e) => e.name === 'helper')).toBe(true);
  });

  it('extracts default export', () => {
    const result = parseFile('test.ts', `export default function App() {}`);
    expect(result!.exports.some((e) => e.isDefault)).toBe(true);
  });

  // ── Used identifiers ─────────────────────────────────────────────────────

  it('tracks used identifiers', () => {
    const result = parseFile('test.ts', `
      import { useState } from 'react';
      const count = useState(0);
    `);
    expect(result!.usedIdentifiers.has('useState')).toBe(true);
  });

  it('marks unused import specifier as NOT in usedIdentifiers', () => {
    const result = parseFile('test.ts', `
      import { useState, useEffect } from 'react';
      const x = useState(0);
    `);
    // useState IS used, useEffect is NOT
    expect(result!.usedIdentifiers.has('useState')).toBe(true);
    expect(result!.usedIdentifiers.has('useEffect')).toBe(false);
  });

  // ── JSX & TSX ─────────────────────────────────────────────────────────────

  it('parses JSX syntax', () => {
    const result = parseFile('comp.tsx', `
      import React from 'react';
      const App = () => <div>Hello</div>;
    `);
    expect(result).not.toBeNull();
  });

  // ── Decorators ────────────────────────────────────────────────────────────

  it('parses TypeScript decorators', () => {
    const result = parseFile('service.ts', `
      function Injectable() { return (t: unknown) => t; }
      @Injectable()
      class UserService {}
    `);
    expect(result).not.toBeNull();
  });
});
