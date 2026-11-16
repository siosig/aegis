/**
 * Shared skeleton for the read-only CLI subcommands (`edges`, `resolve`, `staleness-report`).
 *
 * This layer parses subcommand arguments and runs them on top of `src/core/`.
 * It must not import `src/mcp/` (it does not go through `AegisService`), and
 * `src/core/` must not import this layer.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_DB_DIR } from '../core/init/install-marker.js';
import { buildStalenessReport } from '../core/optimization/staleness-report.js';
import { InvalidTargetPathError, normalizeTargetPath } from '../core/paths.js';
import { ContextCompiler } from '../core/read/compiler.js';
import { buildEdgesOutput, buildResolveOutput, type ResolveTarget } from '../core/read/knowledge-query.js';
import { type AegisDatabase, openDatabaseSnapshot } from '../core/store/database.js';
import { Repository } from '../core/store/repository.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(line: string): void;
}

export interface EdgesCliOptions {
  projectRoot: string;
  dbPath: string;
}

export interface ResolveCliOptions {
  projectRoot: string;
  dbPath: string;
  paths: string[];
}

export interface StalenessReportCliOptions {
  projectRoot: string;
  dbPath: string;
  baseRef: string;
  /** null = compare against the working tree. */
  headRef: string | null;
  /** null = every approved document. */
  docIds: string[] | null;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** CliIo bound to process.stdout / process.stderr (stderr gets a trailing newline). */
export function createProcessCliIo(): CliIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

const READ_COMMAND_OPTIONS = {
  json: { type: 'boolean' },
  db: { type: 'string' },
  'project-root': { type: 'string' },
} as const;

/** One-line message for stderr: Error.message (no stack) with newlines collapsed to a space. */
function formatErrorLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, ' ');
}

/** Parses `edges` arguments; throws CliUsageError on any usage error. */
export function parseEdgesCli(args: string[], cwd: string): EdgesCliOptions {
  let values: ReturnType<typeof parseArgs<{ options: typeof READ_COMMAND_OPTIONS }>>['values'];
  try {
    ({ values } = parseArgs({ args, options: READ_COMMAND_OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new CliUsageError(formatErrorLine(err));
  }
  assertNonEmptyPathOptions(values);
  if (values.json !== true) throw new CliUsageError('--json is required');
  return resolveDbLocation(values, cwd);
}

function assertNonEmptyPathOptions(values: { db?: string; 'project-root'?: string }): void {
  if (values.db === '') throw new CliUsageError('--db requires a non-empty value');
  if (values['project-root'] === '') throw new CliUsageError('--project-root requires a non-empty value');
}

function resolveDbLocation(
  values: { db?: string; 'project-root'?: string },
  cwd: string,
): { projectRoot: string; dbPath: string } {
  const projectRoot = resolve(cwd, values['project-root'] ?? '.');
  const dbPath = values.db !== undefined ? resolve(cwd, values.db) : join(projectRoot, DEFAULT_DB_DIR, 'aegis.db');
  return { projectRoot, dbPath };
}

/** Runs `edges`; returns the process exit code (0 or 2). */
export async function runEdgesCli(args: string[], io: CliIo, cwd: string): Promise<number> {
  let options: EdgesCliOptions;
  try {
    options = parseEdgesCli(args, cwd);
  } catch (err) {
    io.stderr(`[aegis] edges: ${err instanceof CliUsageError ? err.message : formatErrorLine(err)}`);
    return 2;
  }
  const { dbPath } = options;
  if (!existsSync(dbPath)) {
    io.stderr(`[aegis] Database not found at ${dbPath}`);
    return 2;
  }
  let db: AegisDatabase | undefined;
  try {
    db = await openDatabaseSnapshot(dbPath);
    const output = buildEdgesOutput(new Repository(db));
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  } catch (err) {
    io.stderr(`[aegis] edges: ${formatErrorLine(err)}`);
    return 2;
  } finally {
    db?.close();
  }
}

/** Parses `resolve` arguments; throws CliUsageError on any usage error. `--json` is accepted and ignored. */
export function parseResolveCli(args: string[], cwd: string): ResolveCliOptions {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof READ_COMMAND_OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args, options: READ_COMMAND_OPTIONS, strict: true, allowPositionals: true });
  } catch (err) {
    throw new CliUsageError(formatErrorLine(err));
  }
  assertNonEmptyPathOptions(parsed.values);
  if (parsed.positionals.length === 0) throw new CliUsageError('at least one <path> is required');
  return { ...resolveDbLocation(parsed.values, cwd), paths: parsed.positionals };
}

function toResolveTargets(paths: string[], projectRoot: string): ResolveTarget[] {
  return paths.map((path) => ({ path, normalized_path: normalizeTargetPath(path, projectRoot) }));
}

/** Runs `resolve`; returns the process exit code (0 or 2). */
export async function runResolveCli(args: string[], io: CliIo, cwd: string): Promise<number> {
  let options: ResolveCliOptions;
  let targets: ResolveTarget[];
  try {
    options = parseResolveCli(args, cwd);
    targets = toResolveTargets(options.paths, options.projectRoot);
  } catch (err) {
    const known = err instanceof CliUsageError || err instanceof InvalidTargetPathError;
    io.stderr(`[aegis] resolve: ${known ? err.message : formatErrorLine(err)}`);
    return 2;
  }
  const { dbPath } = options;
  if (!existsSync(dbPath)) {
    io.stderr(`[aegis] Database not found at ${dbPath}`);
    return 2;
  }
  let db: AegisDatabase | undefined;
  try {
    db = await openDatabaseSnapshot(dbPath);
    const repo = new Repository(db);
    const output = buildResolveOutput(repo, new ContextCompiler(repo), targets);
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  } catch (err) {
    io.stderr(`[aegis] resolve: ${formatErrorLine(err)}`);
    return 2;
  } finally {
    db?.close();
  }
}

const STALENESS_REPORT_OPTIONS = {
  ...READ_COMMAND_OPTIONS,
  'base-ref': { type: 'string' },
  'head-ref': { type: 'string' },
  'doc-ids': { type: 'string' },
} as const;

/** Parses `staleness-report` arguments; throws CliUsageError on any usage error. `--json` is accepted and ignored. */
export function parseStalenessReportCli(args: string[], cwd: string): StalenessReportCliOptions {
  let values: ReturnType<typeof parseArgs<{ options: typeof STALENESS_REPORT_OPTIONS }>>['values'];
  try {
    ({ values } = parseArgs({ args, options: STALENESS_REPORT_OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new CliUsageError(formatErrorLine(err));
  }
  assertNonEmptyPathOptions(values);
  const baseRef = values['base-ref'];
  if (baseRef === undefined) throw new CliUsageError('--base-ref is required');
  if (baseRef === '') throw new CliUsageError('--base-ref requires a non-empty value');
  const headRef = values['head-ref'];
  if (headRef === '') throw new CliUsageError('--head-ref requires a non-empty value');
  let docIds: string[] | null = null;
  if (values['doc-ids'] !== undefined) {
    docIds = values['doc-ids']
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (docIds.length === 0) throw new CliUsageError('--doc-ids requires at least one doc_id');
  }
  return { ...resolveDbLocation(values, cwd), baseRef, headRef: headRef ?? null, docIds };
}

/**
 * Runs `staleness-report`; returns the process exit code (0 or 2). Prints the Level-3 findings of each document
 * with whether the commit range `--base-ref..--head-ref` (working tree when no head ref) explains them.
 */
export async function runStalenessReportCli(args: string[], io: CliIo, cwd: string): Promise<number> {
  let options: StalenessReportCliOptions;
  try {
    options = parseStalenessReportCli(args, cwd);
  } catch (err) {
    io.stderr(`[aegis] staleness-report: ${err instanceof CliUsageError ? err.message : formatErrorLine(err)}`);
    return 2;
  }
  const { dbPath } = options;
  if (!existsSync(dbPath)) {
    io.stderr(`[aegis] Database not found at ${dbPath}`);
    return 2;
  }
  let db: AegisDatabase | undefined;
  try {
    db = await openDatabaseSnapshot(dbPath);
    const output = buildStalenessReport(new Repository(db), options.projectRoot, {
      docIds: options.docIds,
      baseRef: options.baseRef,
      headRef: options.headRef,
    });
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  } catch (err) {
    io.stderr(`[aegis] staleness-report: ${formatErrorLine(err)}`);
    return 2;
  } finally {
    db?.close();
  }
}
