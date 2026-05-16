/**
 * AST parser — uses @babel/parser + @babel/traverse to extract import, export,
 * variable, and function metadata from a single source file.
 *
 * Never throws: all errors are logged and `null` is returned.
 */

import * as babelParser from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type * as BabelTypes from '@babel/types';
import type {
  ParsedFile,
  ImportInfo,
  ImportSpecifierInfo,
  ExportInfo,
  VariableInfo,
  FunctionInfo,
} from '../../types.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Babel traverse interop
// ---------------------------------------------------------------------------
// @babel/traverse ships its export under `.default` in CommonJS environments.
const traverse =
  (traverseModule as unknown as { default: typeof traverseModule }).default ??
  traverseModule;

// ---------------------------------------------------------------------------
// Parser options
// ---------------------------------------------------------------------------

const BABEL_PLUGINS: babelParser.ParserPlugin[] = [
  'typescript',
  'jsx',
  ['decorators', { decoratorsBeforeExport: true }],
  'classProperties',
  'classStaticBlock',
  'topLevelAwait',
  'importMeta',
  'dynamicImport',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the 1-based line number of a node, defaulting to 0 when absent. */
function lineOf(node: BabelTypes.Node | null | undefined): number {
  return node?.loc?.start.line ?? 0;
}

/**
 * Determine whether a VariableDeclaration or FunctionDeclaration node path
 * is directly wrapped in an ExportNamedDeclaration.
 */
function isDeclarationExported(nodePath: NodePath): boolean {
  const parent = nodePath.parent;
  return parent != null && parent.type === 'ExportNamedDeclaration';
}

// ---------------------------------------------------------------------------
// Specifier extraction
// ---------------------------------------------------------------------------

function extractImportSpecifiers(
  node: BabelTypes.ImportDeclaration,
): ImportSpecifierInfo[] {
  return node.specifiers.map((spec) => {
    if (spec.type === 'ImportDefaultSpecifier') {
      return {
        imported: 'default',
        local: spec.local.name,
        isDefault: true,
        isNamespace: false,
        isTypeOnly: node.importKind === 'type',
      };
    }

    if (spec.type === 'ImportNamespaceSpecifier') {
      return {
        imported: '*',
        local: spec.local.name,
        isDefault: false,
        isNamespace: true,
        isTypeOnly: node.importKind === 'type',
      };
    }

    // ImportSpecifier
    const s = spec as BabelTypes.ImportSpecifier;
    const importedNode = s.imported;
    const importedName =
      importedNode.type === 'Identifier'
        ? importedNode.name
        : (importedNode as BabelTypes.StringLiteral).value;

    return {
      imported: importedName,
      local: s.local.name,
      isDefault: false,
      isNamespace: false,
      isTypeOnly:
        node.importKind === 'type' ||
        (s.importKind != null && s.importKind === 'type'),
    };
  });
}

// ---------------------------------------------------------------------------
// Export name extraction helpers
// ---------------------------------------------------------------------------

function exportedNameFromSpecifier(
  spec: BabelTypes.ExportSpecifier | BabelTypes.ExportNamespaceSpecifier,
): string {
  if (spec.type === 'ExportNamespaceSpecifier') {
    // ExportNamespaceSpecifier.exported is always an Identifier
    return spec.exported.name;
  }
  // ExportSpecifier.exported is Identifier | StringLiteral
  const exported = (spec as BabelTypes.ExportSpecifier).exported;
  return exported.type === 'Identifier'
    ? exported.name
    : (exported as BabelTypes.StringLiteral).value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse `content` at `filePath` and extract structural metadata.
 *
 * @returns A `ParsedFile` on success, or `null` when the file cannot be parsed.
 */
export function parseFile(filePath: string, content: string): ParsedFile | null {
  // ------------------------------------------------------------------
  // 1. Parse
  // ------------------------------------------------------------------
  let ast: babelParser.ParseResult<BabelTypes.File>;

  try {
    ast = babelParser.parse(content, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
      strictMode: false,
      plugins: BABEL_PLUGINS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Parser: failed to parse "${filePath}" — ${message}`);
    return null;
  }

  // ------------------------------------------------------------------
  // 2. Collect results
  // ------------------------------------------------------------------
  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];
  const variables: VariableInfo[] = [];
  const functions: FunctionInfo[] = [];
  const usedIdentifiers = new Set<string>();

  // Track declaration-site names so we can identify pure references.
  const declaredIdentifiers = new Set<string>();

  const markDeclared = (...names: string[]): void => {
    for (const n of names) {
      if (n) declaredIdentifiers.add(n);
    }
  };

  // ------------------------------------------------------------------
  // 3. Traverse
  // ------------------------------------------------------------------
  try {
    traverse(ast, {
      // ----------------------------------------------------------------
      // Static import declarations
      // ----------------------------------------------------------------
      ImportDeclaration(nodePath: NodePath<BabelTypes.ImportDeclaration>) {
        const node = nodePath.node;
        const specifiers = extractImportSpecifiers(node);

        // Record local bindings as declaration sites.
        for (const s of specifiers) {
          markDeclared(s.local);
        }

        imports.push({
          source: node.source.value,
          specifiers,
          isTypeOnly: node.importKind === 'type',
          isDynamic: false,
          line: lineOf(node),
        });
      },

      // ----------------------------------------------------------------
      // Dynamic imports: import('…')
      // ----------------------------------------------------------------
      Import(nodePath: NodePath<BabelTypes.Import>) {
        // The `Import` node is the `import` keyword inside `import('…')`.
        // The parent is a CallExpression.
        const parent = nodePath.parent;
        if (parent.type !== 'CallExpression') return;

        const call = parent as BabelTypes.CallExpression;
        const firstArg = call.arguments[0];
        if (!firstArg) return;

        let source: string | null = null;

        if (firstArg.type === 'StringLiteral') {
          source = (firstArg as BabelTypes.StringLiteral).value;
        } else if (
          firstArg.type === 'TemplateLiteral' &&
          (firstArg as BabelTypes.TemplateLiteral).quasis.length === 1
        ) {
          const quasi = (firstArg as BabelTypes.TemplateLiteral).quasis[0];
          source = quasi?.value.cooked ?? quasi?.value.raw ?? null;
        }

        if (source === null) return;

        imports.push({
          source,
          specifiers: [],
          isTypeOnly: false,
          isDynamic: true,
          line: lineOf(parent),
        });
      },

      // ----------------------------------------------------------------
      // require('…') calls — captures CJS-style dynamic imports
      // ----------------------------------------------------------------
      CallExpression(nodePath: NodePath<BabelTypes.CallExpression>) {
        const node = nodePath.node;
        const callee = node.callee;

        if (
          callee.type !== 'Identifier' ||
          (callee as BabelTypes.Identifier).name !== 'require'
        ) {
          return;
        }

        const firstArg = node.arguments[0];
        if (!firstArg || firstArg.type !== 'StringLiteral') return;

        const source = (firstArg as BabelTypes.StringLiteral).value;
        if (!source) return;

        imports.push({
          source,
          specifiers: [],
          isTypeOnly: false,
          isDynamic: true,
          line: lineOf(node),
        });
      },

      // ----------------------------------------------------------------
      // Named exports
      // ----------------------------------------------------------------
      ExportNamedDeclaration(
        nodePath: NodePath<BabelTypes.ExportNamedDeclaration>,
      ) {
        const node = nodePath.node;
        const names: string[] = [];

        if (node.specifiers.length > 0) {
          for (const spec of node.specifiers) {
            if (
              spec.type === 'ExportSpecifier' ||
              spec.type === 'ExportNamespaceSpecifier'
            ) {
              names.push(
                exportedNameFromSpecifier(
                  spec as
                    | BabelTypes.ExportSpecifier
                    | BabelTypes.ExportNamespaceSpecifier,
                ),
              );
            }
          }
        } else if (node.declaration) {
          const decl = node.declaration;

          if (
            decl.type === 'FunctionDeclaration' ||
            decl.type === 'ClassDeclaration'
          ) {
            const named = decl as
              | BabelTypes.FunctionDeclaration
              | BabelTypes.ClassDeclaration;
            if (named.id) names.push(named.id.name);
          } else if (decl.type === 'VariableDeclaration') {
            for (const declarator of (decl as BabelTypes.VariableDeclaration)
              .declarations) {
              if (declarator.id.type === 'Identifier') {
                names.push((declarator.id as BabelTypes.Identifier).name);
              }
            }
          } else if (decl.type === 'TSDeclareFunction') {
            const tsDecl = decl as BabelTypes.TSDeclareFunction;
            if (tsDecl.id) names.push(tsDecl.id.name);
          }
        }

        const sourceVal = node.source?.value;

        const info: ExportInfo = {
          name: names.join(', '),
          isDefault: false,
          isReExport: node.source != null,
          line: lineOf(node),
        };
        if (sourceVal !== undefined) {
          info.source = sourceVal;
        }
        exports.push(info);
      },

      // ----------------------------------------------------------------
      // Default exports
      // ----------------------------------------------------------------
      ExportDefaultDeclaration(
        nodePath: NodePath<BabelTypes.ExportDefaultDeclaration>,
      ) {
        const node = nodePath.node;
        let name = 'default';

        const decl = node.declaration;
        if (
          (decl.type === 'FunctionDeclaration' ||
            decl.type === 'ClassDeclaration') &&
          (decl as BabelTypes.FunctionDeclaration | BabelTypes.ClassDeclaration)
            .id
        ) {
          name = (
            decl as BabelTypes.FunctionDeclaration | BabelTypes.ClassDeclaration
          ).id!.name;
        } else if (decl.type === 'Identifier') {
          name = (decl as BabelTypes.Identifier).name;
        }

        exports.push({
          name,
          isDefault: true,
          isReExport: false,
          line: lineOf(node),
        });
      },

      // ----------------------------------------------------------------
      // Re-export all: export * from '…'
      // ----------------------------------------------------------------
      ExportAllDeclaration(
        nodePath: NodePath<BabelTypes.ExportAllDeclaration>,
      ) {
        const node = nodePath.node;

        exports.push({
          name: '*',
          isDefault: false,
          isReExport: true,
          source: node.source.value,
          line: lineOf(node),
        });
      },

      // ----------------------------------------------------------------
      // Variable declarations — top-level and inside functions
      // ----------------------------------------------------------------
      VariableDeclaration(
        nodePath: NodePath<BabelTypes.VariableDeclaration>,
      ) {
        const parentType = nodePath.parent.type;
        const isTopLevel =
          parentType === 'Program' ||
          parentType === 'ExportNamedDeclaration';

        // Variables inside for-loop initialisers are not meaningful to track.
        if (
          parentType === 'ForStatement' ||
          parentType === 'ForInStatement' ||
          parentType === 'ForOfStatement'
        ) return;

        const node = nodePath.node;
        const exported = isDeclarationExported(nodePath);
        const kind = node.kind as 'const' | 'let' | 'var';
        const inFunction = !isTopLevel;

        for (const declarator of node.declarations) {
          if (declarator.id.type !== 'Identifier') continue;
          const name = (declarator.id as BabelTypes.Identifier).name;
          markDeclared(name);

          variables.push({ name, kind, line: lineOf(node), inFunction });

          // Top-level arrow / function expressions also go into functions[].
          if (isTopLevel) {
            const init = declarator.init;
            if (
              init &&
              (init.type === 'ArrowFunctionExpression' ||
                init.type === 'FunctionExpression')
            ) {
              const fn = init as
                | BabelTypes.ArrowFunctionExpression
                | BabelTypes.FunctionExpression;
              functions.push({
                name,
                isExported: exported,
                isArrow: init.type === 'ArrowFunctionExpression',
                line: lineOf(node),
              });
              void fn.params;
            }
          }
        }
      },

      // ----------------------------------------------------------------
      // Function declarations (top-level only)
      // ----------------------------------------------------------------
      FunctionDeclaration(
        nodePath: NodePath<BabelTypes.FunctionDeclaration>,
      ) {
        const parentType = nodePath.parent.type;
        const isTopLevel =
          parentType === 'Program' ||
          parentType === 'ExportNamedDeclaration';
        if (!isTopLevel) return;

        const node = nodePath.node;
        if (!node.id) return; // anonymous function declaration edge case

        const name = node.id.name;
        markDeclared(name);

        functions.push({
          name,
          isExported: isDeclarationExported(nodePath),
          isArrow: false,
          line: lineOf(node),
        });
      },

      // ----------------------------------------------------------------
      // Identifier references — collect all value-position identifiers
      // ----------------------------------------------------------------
      Identifier(nodePath: NodePath<BabelTypes.Identifier>) {
        const node = nodePath.node;

        // Skip pure binding sites (left-hand side of declarations).
        if (
          (
            nodePath as NodePath<BabelTypes.Identifier> & {
              isBindingIdentifier?(): boolean;
            }
          ).isBindingIdentifier?.()
        ) {
          return;
        }

        // Skip property keys in non-computed member expressions: `foo.bar`
        const parentNode = nodePath.parent;
        if (
          parentNode.type === 'MemberExpression' &&
          (parentNode as BabelTypes.MemberExpression).property === node &&
          !(parentNode as BabelTypes.MemberExpression).computed
        ) {
          return;
        }

        // Skip keys of non-computed object properties: `{ foo: … }`
        if (
          parentNode.type === 'ObjectProperty' &&
          (parentNode as BabelTypes.ObjectProperty).key === node &&
          !(parentNode as BabelTypes.ObjectProperty).computed
        ) {
          return;
        }

        // Skip identifiers that are part of import specifier positions.
        // ImportSpecifier.imported is the remote export name (not a local use).
        // ImportSpecifier.local / ImportDefaultSpecifier.local /
        // ImportNamespaceSpecifier.local are binding sites already covered by
        // isBindingIdentifier(), but we guard them here for safety too.
        if (
          parentNode.type === 'ImportSpecifier' ||
          parentNode.type === 'ImportDefaultSpecifier' ||
          parentNode.type === 'ImportNamespaceSpecifier'
        ) {
          return;
        }

        usedIdentifiers.add(node.name);
      },

      // ----------------------------------------------------------------
      // JSX element names — <Button />, <MyComponent>, <Foo.Bar />
      // JSXIdentifier is separate from Identifier in Babel's AST.
      // ----------------------------------------------------------------
      JSXOpeningElement(nodePath: NodePath<BabelTypes.JSXOpeningElement>) {
        const name = nodePath.node.name;

        if (name.type === 'JSXIdentifier') {
          // Only capitalised names are component references (lowercase = DOM tag)
          const first = name.name[0];
          if (first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase()) {
            usedIdentifiers.add(name.name);
          }
          // If any JSX is present, React (classic transform) is implicitly used
          usedIdentifiers.add('React');
        } else if (name.type === 'JSXMemberExpression') {
          // <Foo.Bar /> — walk leftmost object
          let obj: BabelTypes.JSXMemberExpression | BabelTypes.JSXIdentifier = name;
          while (obj.type === 'JSXMemberExpression') {
            obj = obj.object;
          }
          if (obj.type === 'JSXIdentifier') {
            usedIdentifiers.add(obj.name);
          }
        } else if (name.type === 'JSXNamespacedName') {
          // <foo:bar /> — rare, but track the namespace
          usedIdentifiers.add(name.namespace.name);
        }
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Parser: traverse failed for "${filePath}" — ${message}`);
    return null;
  }

  return {
    path: filePath,
    ast,
    imports,
    exports,
    variables,
    functions,
    usedIdentifiers,
  };
}
