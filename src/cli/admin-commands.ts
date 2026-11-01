/**
 * The 9 CLI subcommands that correspond to admin-only MCP tools. They call `AegisService` with
 * surface `'admin'` (FR-001), so unlike `src/cli/read-commands.ts` this layer imports `src/mcp/`
 * (services, tool-input-schemas, tool-error).
 *
 * This layer parses subcommand arguments and a JSON input, then runs the operation. It never terminates
 * the process itself; the caller maps the returned exit code to the exit status.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { text } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { InitPreview } from '../core/init/engine.js';
import { DEFAULT_DB_DIR } from '../core/init/install-marker.js';
import {
  type AegisDatabase,
  createDatabase,
  createInMemoryDatabase,
  ensureDatabaseDirectory,
} from '../core/store/database.js';
import { Repository } from '../core/store/repository.js';
import { AegisService } from '../mcp/services.js';
import { errorMessage } from '../mcp/tool-error.js';
import {
  analyzeImportBatchInputShape,
  applyUpgradeInputShape,
  approveProposalInputShape,
  executeImportPlanInputShape,
  importDocInputShape,
  initConfirmInputShape,
  initDetectInputShape,
  proposalBundleInputShape,
  rejectProposalInputShape,
} from '../mcp/tool-input-schemas.js';
import { type CliIo, CliUsageError, createProcessCliIo } from './read-commands.js';

export const ADMIN_CLI_SUBCOMMANDS = [
  'import-doc',
  'analyze-import-batch',
  'execute-import-plan',
  'init-confirm',
  'apply-upgrade',
  'reject-proposal',
  'preflight-proposal-bundle',
  'approve-proposal-bundle',
  'approve-proposal',
] as const;

export type AdminCliSubcommand = (typeof ADMIN_CLI_SUBCOMMANDS)[number];

/** Exact-match check; `undefined` is never a subcommand. */
export function isAdminCliSubcommand(value: string | undefined): value is AdminCliSubcommand {
  return value !== undefined && (ADMIN_CLI_SUBCOMMANDS as readonly string[]).includes(value);
}

export const ADMIN_CLI_EXIT = { ok: 0, resultFailure: 1, error: 2 } as const;

export type AdminCliExitCode = (typeof ADMIN_CLI_EXIT)[keyof typeof ADMIN_CLI_EXIT];

export interface AdminCliIo extends CliIo {
  readStdin(): Promise<string>;
}

/** AdminCliIo bound to process.stdin / process.stdout / process.stderr. */
export function createProcessAdminCliIo(): AdminCliIo {
  return { ...createProcessCliIo(), readStdin: () => text(process.stdin) };
}

export interface AdminCliOptions {
  projectRoot: string;
  dbPath: string;
  templatesRoot: string;
  extraTemplateDirs: string[];
  /** null: no input (`{}`); '-': stdin; otherwise an absolute file path. */
  inputSource: string | null;
}

export const initConfirmCliInputSchema = z.strictObject({
  preview_hash: initConfirmInputShape.preview_hash,
  project_root: z.string().min(1).optional(),
  skip_template: initDetectInputShape.skip_template,
});

const ADMIN_CLI_PARSE_OPTIONS = {
  input: { type: 'string' },
  db: { type: 'string' },
  'project-root': { type: 'string' },
  templates: { type: 'string' },
  'template-dir': { type: 'string', multiple: true },
} as const;

/** Collapses newlines (and surrounding whitespace) to a single space. */
function collapseNewlines(message: string): string {
  return message.replace(/\s*\n\s*/g, ' ');
}

function parseAdminCliValues(
  args: string[],
): ReturnType<typeof parseArgs<{ options: typeof ADMIN_CLI_PARSE_OPTIONS }>>['values'] {
  try {
    return parseArgs({ args, options: ADMIN_CLI_PARSE_OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (err) {
    throw new CliUsageError(collapseNewlines(errorMessage(err)));
  }
}

function assertNonEmptyOptions(values: ReturnType<typeof parseAdminCliValues>): void {
  const scalars = ['input', 'db', 'project-root', 'templates'] as const;
  for (const name of scalars) {
    if (values[name] === '') throw new CliUsageError(`--${name} requires a non-empty value`);
  }
  if ((values['template-dir'] ?? []).includes('')) throw new CliUsageError('--template-dir requires a non-empty value');
}

/** Parses the common admin CLI options; throws CliUsageError on any usage error. */
export function parseAdminCliOptions(args: string[], cwd: string, defaultTemplatesRoot: string): AdminCliOptions {
  const values = parseAdminCliValues(args);
  assertNonEmptyOptions(values);
  const projectRoot = resolve(cwd, values['project-root'] ?? '.');
  const dbPath = values.db !== undefined ? resolve(cwd, values.db) : join(projectRoot, DEFAULT_DB_DIR, 'aegis.db');
  const templatesRoot = values.templates !== undefined ? resolve(cwd, values.templates) : defaultTemplatesRoot;
  const extraTemplateDirs = (values['template-dir'] ?? []).map((d) => resolve(cwd, d));
  let inputSource: string | null = null;
  if (values.input !== undefined) inputSource = values.input === '-' ? '-' : resolve(cwd, values.input);
  return { projectRoot, dbPath, templatesRoot, extraTemplateDirs, inputSource };
}

// ── Operation table ──────────────────────────────────────────────────────

interface AdminOperationContext {
  service: AegisService;
}

interface PreparedResult {
  result: unknown;
  exitCode: AdminCliExitCode;
  /** One stderr line (without the `[aegis] <subcommand>: ` prefix) when exitCode is resultFailure. */
  failureSummary: string | null;
}

/** A validated input bound to an operation that can be run. */
interface PreparedOperation {
  run(ctx: AdminOperationContext): Promise<PreparedResult>;
}

interface AdminOperationDefinition {
  /** Validates the raw input; throws CliUsageError on failure. */
  prepare(rawInput: unknown): PreparedOperation;
}

interface OperationOutcome {
  exitCode: AdminCliExitCode;
  failureSummary: string | null;
}

const OUTCOME_OK: OperationOutcome = { exitCode: ADMIN_CLI_EXIT.ok, failureSummary: null };

function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  const parts = issues.map((i) => `${i.path.length === 0 ? '(root)' : i.path.map(String).join('.')}: ${i.message}`);
  return `invalid input: ${parts.join('; ')}`;
}

/** Builds a definition that validates with `schema`, calls `run`, and derives the exit code via `outcomeOf`. */
function defineOperation<S extends z.ZodType, R>(
  schema: S,
  run: (input: z.output<S>, ctx: AdminOperationContext) => R | Promise<R>,
  outcomeOf?: (result: R) => OperationOutcome,
): AdminOperationDefinition {
  return {
    prepare(rawInput: unknown): PreparedOperation {
      const parsed = schema.safeParse(rawInput);
      if (!parsed.success) throw new CliUsageError(formatIssues(parsed.error.issues));
      return {
        async run(ctx: AdminOperationContext): Promise<PreparedResult> {
          const result = await run(parsed.data, ctx);
          return { result, ...(outcomeOf ? outcomeOf(result) : OUTCOME_OK) };
        },
      };
    },
  };
}

function preflightOutcome(result: { ok: boolean; bundle_id: string; ordering_error?: string }): OperationOutcome {
  if (result.ok !== false) return OUTCOME_OK;
  const ordering = result.ordering_error ? ` ordering_error=${collapseNewlines(result.ordering_error)}` : '';
  return {
    exitCode: ADMIN_CLI_EXIT.resultFailure,
    failureSummary: `ok=false bundle_id=${result.bundle_id}${ordering}`,
  };
}

const ADMIN_OPERATIONS: Record<Exclude<AdminCliSubcommand, 'init-confirm'>, AdminOperationDefinition> = {
  'import-doc': defineOperation(z.strictObject(importDocInputShape), (input, { service }) =>
    service.importDoc(input, 'admin'),
  ),
  'analyze-import-batch': defineOperation(z.strictObject(analyzeImportBatchInputShape), (input, { service }) =>
    service.analyzeImportBatch(input, 'admin'),
  ),
  'execute-import-plan': defineOperation(z.strictObject(executeImportPlanInputShape), (input, { service }) =>
    service.executeImportPlan(input, 'admin'),
  ),
  'apply-upgrade': defineOperation(z.strictObject(applyUpgradeInputShape), (_input, { service }) =>
    service.applyUpgrade('admin'),
  ),
  'reject-proposal': defineOperation(z.strictObject(rejectProposalInputShape), (input, { service }) =>
    service.rejectProposal(input.proposal_id, input.reason, 'admin'),
  ),
  'preflight-proposal-bundle': defineOperation(
    z.strictObject(proposalBundleInputShape),
    (input, { service }) => service.preflightProposalBundle(input.bundle_id, 'admin'),
    preflightOutcome,
  ),
  'approve-proposal-bundle': defineOperation(z.strictObject(proposalBundleInputShape), (input, { service }) =>
    service.approveProposalBundle(input.bundle_id, 'admin'),
  ),
  'approve-proposal': defineOperation(z.strictObject(approveProposalInputShape), (input, { service }) =>
    service.approveProposal(input.proposal_id, input.modifications, 'admin'),
  ),
};

// ── Runner ───────────────────────────────────────────────────────────────

/** Reads and JSON-parses the input; `null` source yields `{}` without parsing. */
async function readRawInput(inputSource: string | null, io: AdminCliIo): Promise<unknown> {
  if (inputSource === null) return {};
  let content: string;
  try {
    content = inputSource === '-' ? await io.readStdin() : readFileSync(inputSource, 'utf-8');
  } catch (err) {
    throw new CliUsageError(`cannot read --input ${inputSource}: ${errorMessage(err)}`);
  }
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new CliUsageError(`invalid input: not valid JSON (${errorMessage(err)})`);
  }
}

function createAdminService(db: AegisDatabase, options: AdminCliOptions): AegisService {
  return new AegisService(
    new Repository(db),
    options.templatesRoot,
    null,
    options.extraTemplateDirs,
    false,
    options.projectRoot,
  );
}

/** Writes the result to stdout (and the failure summary to stderr); returns the exit code. */
function writeOutcome(io: AdminCliIo, subcommand: AdminCliSubcommand, outcome: PreparedResult): AdminCliExitCode {
  io.stdout(`${JSON.stringify(outcome.result, null, 2)}\n`);
  if (outcome.exitCode === ADMIN_CLI_EXIT.resultFailure) {
    io.stderr(`[aegis] ${subcommand}: ${outcome.failureSummary}`);
  }
  return outcome.exitCode;
}

async function runPrepared(
  subcommand: AdminCliSubcommand,
  prepared: PreparedOperation,
  options: AdminCliOptions,
  io: AdminCliIo,
): Promise<AdminCliExitCode> {
  if (!existsSync(options.dbPath)) {
    io.stderr(`[aegis] Database not found at ${options.dbPath}`);
    return ADMIN_CLI_EXIT.error;
  }
  const db = await createDatabase(options.dbPath);
  try {
    const outcome = await prepared.run({ service: createAdminService(db, options) });
    return writeOutcome(io, subcommand, outcome);
  } finally {
    db.close();
  }
}

type InitConfirmInput = z.output<typeof initConfirmCliInputSchema>;

function verifyInitPreview(preview: InitPreview, expectedHash: string): void {
  if (preview.has_blocking_warnings) {
    const blocking = preview.warnings.filter((w) => w.severity === 'block').map((w) => w.message);
    throw new Error(
      `init_detect reported blocking warnings: ${blocking.length > 0 ? blocking.join('; ') : '(no message)'}`,
    );
  }
  if (preview.preview_hash !== expectedHash) {
    throw new Error(
      `preview_hash mismatch: expected ${expectedHash} but init_detect produced ${preview.preview_hash}. ` +
        'Pass the same project_root, skip_template, --templates and --template-dir as the aegis_init_detect call.',
    );
  }
}

function detectAndVerify(service: AegisService, projectRootForDetect: string, input: InitConfirmInput): void {
  const preview = service.initDetect(projectRootForDetect, 'admin', { skip_template: input.skip_template });
  verifyInitPreview(preview, input.preview_hash);
}

/** Dry-runs detection on an in-memory DB so that nothing is created on disk when verification fails. */
async function verifyBeforeCreatingDatabase(
  options: AdminCliOptions,
  projectRootForDetect: string,
  input: InitConfirmInput,
): Promise<void> {
  const memoryDb = await createInMemoryDatabase();
  try {
    detectAndVerify(createAdminService(memoryDb, options), projectRootForDetect, input);
  } finally {
    memoryDb.close();
  }
}

async function runInitConfirm(
  raw: unknown,
  options: AdminCliOptions,
  io: AdminCliIo,
  cwd: string,
): Promise<AdminCliExitCode> {
  const parsed = initConfirmCliInputSchema.safeParse(raw);
  if (!parsed.success) throw new CliUsageError(formatIssues(parsed.error.issues));
  const input = parsed.data;
  const projectRootForDetect =
    input.project_root !== undefined ? resolve(cwd, input.project_root) : options.projectRoot;
  if (!existsSync(options.dbPath)) {
    await verifyBeforeCreatingDatabase(options, projectRootForDetect, input);
    ensureDatabaseDirectory(options.dbPath);
  }
  const db = await createDatabase(options.dbPath);
  try {
    const service = createAdminService(db, options);
    detectAndVerify(service, projectRootForDetect, input);
    const result = service.initConfirm(input.preview_hash, 'admin');
    return writeOutcome(io, 'init-confirm', { result, ...OUTCOME_OK });
  } finally {
    db.close();
  }
}

/** Runs one admin subcommand; returns the exit code (0, 1 or 2). */
export async function runAdminCli(
  subcommand: AdminCliSubcommand,
  args: string[],
  io: AdminCliIo,
  cwd: string,
  defaultTemplatesRoot: string,
): Promise<AdminCliExitCode> {
  try {
    const options = parseAdminCliOptions(args, cwd, defaultTemplatesRoot);
    const raw = await readRawInput(options.inputSource, io);
    if (subcommand === 'init-confirm') return await runInitConfirm(raw, options, io, cwd);
    const prepared = ADMIN_OPERATIONS[subcommand].prepare(raw);
    return await runPrepared(subcommand, prepared, options, io);
  } catch (err) {
    const message = err instanceof CliUsageError ? err.message : collapseNewlines(errorMessage(err));
    io.stderr(`[aegis] ${subcommand}: ${message}`);
    return ADMIN_CLI_EXIT.error;
  }
}
