# depdoctor

> Production-grade dependency and code health CLI for Node.js & TypeScript projects.

[![npm version](https://badge.fury.io/js/depdoctor.svg)](https://www.npmjs.com/package/depdoctor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

---

## What it does

`depdoctor` scans your project and finds:

- **Unused dependencies** — packages listed in `package.json` but never imported
- **Unused imports** — specifiers imported but never referenced in code
- **Unused variables** — declared but never used
- **Vulnerabilities** — via `npm audit` integration
- **Dangerous scripts** — `curl | bash` patterns in `postinstall`
- **Typosquatting** — suspicious package names that mimic popular packages
- **Bad `.env` variables** — duplicates and invalid naming

---

## Install

```bash
npm install -g depdoctor
```

---

## Usage

### Scan your project

```bash
depdoctor scan
```

```
depdoctor — dependency & code health report
════════════════════════════════════════════
Scanned: 312 file(s) in 420ms

Unused Dependencies (3)
  ⚠ lodash   — not imported anywhere
  ⚠ moment   — not imported anywhere
  ⚠ uuid     — not imported anywhere

Security Issues (1)
  ❌ express  critical — Prototype Pollution
```

### Fix issues (dry run first)

```bash
depdoctor fix --dry-run   # preview
depdoctor fix             # apply with confirmation
```

### Security audit only

```bash
depdoctor security
```

### Generate a Markdown report

```bash
depdoctor report --markdown
# writes .depdoctor-report.md
```

### JSON output (for CI)

```bash
depdoctor scan --json
```

### Rollback last fix

```bash
depdoctor rollback
```

---

## Options

| Command | Flag | Description |
|---------|------|-------------|
| `scan` | `--json` | Output as JSON |
| `scan` | `--no-security` | Skip security checks |
| `scan` | `--cwd <path>` | Project root (default: cwd) |
| `fix` | `--dry-run` | Preview without modifying |
| `fix` | `--yes` | Skip confirmation prompt |
| `report` | `--markdown` | Write `.depdoctor-report.md` |
| `report` | `--output <file>` | Custom output path |
| `security` | `--json` | Output as JSON |
| All | `--debug` | Enable debug logging |

---

## Configuration

Create `.depdoctorrc` in your project root:

```json
{
  "ignoreDependencies": ["react", "react-dom"],
  "ignoreVariables": ["_temp"],
  "security": true,
  "fix": false,
  "maxFileSizeMB": 10
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ignoreDependencies` | `string[]` | `[]` | Packages to skip in dep check |
| `ignoreVariables` | `string[]` | `[]` | Variable names to skip |
| `ignoreFiles` | `string[]` | `[]` | File patterns to skip |
| `security` | `boolean` | `true` | Enable security checks |
| `fix` | `boolean` | `false` | Auto-fix on scan |
| `maxFileSizeMB` | `number` | `10` | Max file size to parse |
| `maxFiles` | `number` | `10000` | Max files to scan |

---

## Security Architecture

- **No code execution** — only static analysis, never `require(userFile)`
- **Path traversal protection** — all file operations validated within project root
- **Symlink protection** — symbolic links are skipped
- **DOS limits** — max file count, file size, and recursion depth enforced

---

## Requirements

- Node.js >= 18
- npm, yarn, or pnpm

---

## License

MIT
