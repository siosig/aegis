/**
 * Aegis MCP Server
 * Tool registration only. All business logic delegated to AegisService.
 *
 * Surface separation (INV-6):
 * - Agent Surface: compile_context, observe, get_compile_audit, get_known_tags, workspace_status, init_detect (6 tools)
 * - SSA Surface: the 6 agent tools plus list/get proposal, archive_observations, get_stats,
 *                process_observations, sync_docs (12 tools). No approval on ssa: approve via the
 *                admin surface or the `approve-proposal` CLI. See ADR-020.
 * - Admin Surface: the 12 SSA tools plus 12 admin-only (approve_proposal, bundle preflight/approve, reject,
 *                  init_confirm, check_upgrade, apply_upgrade, import_doc, analyze_doc, analyze_import_batch,
 *                  execute_import_plan, list_observations) → 24 tools total
 * - Dormant mode (createDormantAegisServer): Aegis not installed in the project and no --db.
 *   Only workspace_status and init_detect (2 tools) on every surface; no resources.
 * - propose is NOT exposed (internal only)
 *
 * init_detect is on all surfaces (read-only preview).
 * init_confirm is admin-only (mutates Canonical).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DORMANT_WORKSPACE_STATUS_NOTICE } from '../core/init/install-marker.js';
import { BudgetExceededError } from '../core/types.js';
import { type AegisService, ObserveValidationError, type Surface } from './services.js';
import { toolErrorResult } from './tool-error.js';
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
  sourceRefSchema,
} from './tool-input-schemas.js';

type TextContent = { type: 'text'; text: string };

/** Build MCP content blocks for aegis_observe response. Exported for testing. */
export function buildObserveContent(result: { observation_id: string }, eventType: string): TextContent[] {
  const content: TextContent[] = [{ type: 'text', text: JSON.stringify(result) }];
  if (eventType === 'compile_miss') {
    content.push({
      type: 'text',
      text: 'Hint: An admin should run `aegis_list_observations({ outcome: "skipped" })` periodically to triage compile misses that the analyzer could not automatically resolve.',
    });
  }
  return content;
}

const WORKFLOW_GUIDE = `# Aegis Workflow Guide

## Core Workflow: Read → Write → Approve

1. **Read** — Before editing, call \`aegis_compile_context\` with your target files.
   Aegis returns relevant guidelines, patterns, constraints, and templates.

   Each document has a \`delivery\` field:
   - \`inline\`: Full content is included in the response. Read it directly.
   - \`deferred\`: Content is NOT included. You MUST Read the file via \`source_path\` before proceeding. Prioritize by \`relevance\` score (high first); skip only documents with very low relevance (< 0.25) unless specifically needed.
   - \`omitted\`: Excluded by budget or policy. Increase \`max_inline_bytes\` or use \`content_mode: "always"\` if needed.

   The default \`content_mode\` is \`auto\`: documents with \`source_path\` are deferred (except small ones ≤ 4KB),
   documents without \`source_path\` are always inlined. Use \`content_mode: "always"\` to force all documents inline.

2. **Write** — After coding, report what happened via \`aegis_observe\`:
   - \`compile_miss\`: context didn't cover what was needed
   - \`review_correction\`: reviewer corrected an agent's output
   - \`pr_merged\`: PR merged with file changes
   - \`manual_note\`: freeform knowledge capture
   - \`document_import\`: propose importing a document into Canonical (admin pipeline)
   - \`doc_gap_detected\`: diagnostic gap record (ADR-015 \`DocGapPayload\`; no proposal)

3. **Approve** — Admin reviews proposals generated from observations:
   - \`aegis_list_proposals\` → \`aegis_get_proposal\` → \`aegis_approve_proposal\` / \`aegis_reject_proposal\`

## Admin Operations

- \`aegis_init_detect\` + \`aegis_init_confirm\`: Initialize a project
- \`aegis_import_doc\`: Import existing documents with explicit metadata
- \`aegis_process_observations\`: Run the analyzer pipeline on pending observations
- \`aegis_list_observations\`: Triage observations by outcome (proposed/skipped/pending)
- \`aegis_check_upgrade\` + \`aegis_apply_upgrade\`: Template version upgrades

## Key Principles

- **Observation → Proposal → Canonical**: No direct writes to Canonical Knowledge
- **Agent surface is read-only**: Agents can read context and record observations, but cannot approve
- **Deterministic context**: Same inputs always produce the same compiled context
`;

/**
 * Register `aegis_workspace_status`. When `leadingNotice` is a string (dormant mode) it is returned
 * as `content[0]` ahead of the JSON snapshot; when `null` the response is the JSON snapshot only.
 */
function registerWorkspaceStatusTool(
  server: McpServer,
  service: AegisService,
  surface: Surface,
  leadingNotice: string | null,
): void {
  server.tool(
    'aegis_workspace_status',
    'Read-only workspace snapshot: recent compile regions (from compile_log), unresolved compile_miss observations without proposals, and pending proposal count. Does not mutate Canonical Knowledge.',
    {
      window_hours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .optional()
        .describe('Rolling window in hours for active_regions (default: 24; max: 168).'),
    },
    async (params) => {
      const result = service.workspaceStatus(surface, {
        window_hours: params.window_hours,
      });
      const resultText: TextContent = { type: 'text', text: JSON.stringify(result, null, 2) };
      if (leadingNotice === null) {
        return { content: [resultText] };
      }
      return { content: [{ type: 'text', text: leadingNotice }, resultText] };
    },
  );
}

/** Register `aegis_init_detect` (read-only preview; available on every surface). */
function registerInitDetectTool(server: McpServer, service: AegisService, surface: Surface): void {
  server.tool(
    'aegis_init_detect',
    'Analyze a project and generate an initialization preview. Does not modify Canonical.',
    initDetectInputShape,
    async (params) => {
      const preview = service.initDetect(params.project_root, surface, {
        skip_template: params.skip_template,
      });
      const { _placeholders, ...publicPreview } = preview;
      return { content: [{ type: 'text', text: JSON.stringify(publicPreview, null, 2) }] };
    },
  );
}

/**
 * Dormant mode server: registers exactly `aegis_workspace_status` and `aegis_init_detect`
 * regardless of `surface`, and no resources/prompts.
 * Server info: `{ name: `aegis-${surface}`, version: '0.1.0' }` (same as createAegisServer).
 */
export function createDormantAegisServer(service: AegisService, surface: Surface): McpServer {
  const server = new McpServer({
    name: `aegis-${surface}`,
    version: '0.1.0',
  });
  registerWorkspaceStatusTool(server, service, surface, DORMANT_WORKSPACE_STATUS_NOTICE);
  registerInitDetectTool(server, service, surface);
  return server;
}

export function createAegisServer(service: AegisService, surface: Surface): McpServer {
  const server = new McpServer({
    name: `aegis-${surface}`,
    version: '0.1.0',
  });

  // ============================================================
  // Agent Surface Tools
  // ============================================================

  server.tool(
    'aegis_compile_context',
    'Compile deterministic context for target files. Returns base documents, resolution path, and templates. v2: delivery-aware with budget control.',
    {
      target_files: z.array(z.string()).describe('File paths being edited (required)'),
      target_layers: z
        .array(z.string())
        .optional()
        .describe('Explicit layer names (optional, inferred from path if omitted)'),
      agent_id: z
        .string()
        .optional()
        .describe(
          'Optional client self-id for workspace visibility (stored in compile_log only; does not affect compiled output).',
        ),
      command: z.string().optional().describe('Command name: scaffold, refactor, review, etc.'),
      plan: z.string().optional().describe('Natural-language plan text for expanded context (requires IntentTagger)'),
      intent_tags: z
        .array(z.string())
        .optional()
        .describe(
          'Explicit intent tags for expanded context. When set (including []), the SLM tagger is not used. ' +
            'Omit for SLM fallback from plan.',
        ),
      max_inline_bytes: z
        .number()
        .optional()
        .describe('Inline content budget in UTF-8 bytes (default: 131072 = 128KB)'),
      content_mode: z.enum(['auto', 'always', 'metadata']).optional().describe('Content delivery mode (default: auto)'),
      include_debug: z
        .boolean()
        .optional()
        .describe(
          'Include debug_info (near_miss_edges, layer_classification, budget_dropped) in the response. ' +
            'Default: false — the same diagnostics are always recorded and retrievable via aegis_get_compile_audit.',
        ),
      min_relevance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Omit documents/templates whose relevance score is below this threshold (0-1). ' +
            'Documents without a relevance score (no plan given) are always kept. Default: 0 (no filtering).',
        ),
    },
    async (params) => {
      try {
        const result = await service.compileContext(
          {
            target_files: params.target_files,
            target_layers: params.target_layers,
            agent_id: params.agent_id,
            command: params.command,
            plan: params.plan,
            intent_tags: params.intent_tags,
            max_inline_bytes: params.max_inline_bytes,
            content_mode: params.content_mode,
            include_debug: params.include_debug,
            min_relevance: params.min_relevance,
          },
          surface,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'BUDGET_EXCEEDED_MANDATORY',
                  compile_id: e.compile_id,
                  message: e.message,
                  mandatory_bytes: e.mandatory_bytes,
                  max_inline_bytes: e.max_inline_bytes,
                  offending_doc_ids: e.offending_doc_ids,
                }),
              },
            ],
            isError: true,
          };
        }
        throw e;
      }
    },
  );

  server.tool(
    'aegis_observe',
    'Record an observation event. Writes to Observation Layer only (never Canonical).',
    {
      event_type: z
        .enum([
          'compile_miss',
          'review_correction',
          'pr_merged',
          'manual_note',
          'document_import',
          'doc_gap_detected',
          'staleness_detected',
        ])
        .describe('Event type'),
      related_compile_id: z.string().optional().describe('Required for compile_miss'),
      related_snapshot_id: z.string().optional().describe('Required for compile_miss, optional for review_correction'),
      payload: z.record(z.string(), z.unknown()).describe('Event-specific payload (JSON object)'),
    },
    async (params) => {
      const event = {
        event_type: params.event_type,
        ...(params.related_compile_id && { related_compile_id: params.related_compile_id }),
        ...(params.related_snapshot_id && { related_snapshot_id: params.related_snapshot_id }),
        payload: params.payload,
      } as any;
      try {
        const result = service.observe(event, surface);
        return { content: buildObserveContent(result, params.event_type) };
      } catch (e) {
        if (e instanceof ObserveValidationError) {
          return { content: [{ type: 'text', text: e.message }], isError: true };
        }
        throw e;
      }
    },
  );

  server.tool(
    'aegis_get_compile_audit',
    'Retrieve details of a past compile_context invocation.',
    {
      compile_id: z.string().describe('The compile_id from a previous compile_context call'),
    },
    async (params) => {
      const result = service.getCompileAudit(params.compile_id, surface);
      if (!result) {
        return {
          content: [{ type: 'text', text: `Compile log not found for compile_id: ${params.compile_id}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'aegis_get_known_tags',
    'List distinct intent tags from tag_mappings (approved-resolvable only) with knowledge_version and a SHA-256 tag_catalog_hash of the tag list for client-side caching.',
    {},
    async () => {
      const result = service.getKnownTags(surface);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  registerWorkspaceStatusTool(server, service, surface, null);

  // ============================================================
  // init_detect — available on both surfaces (read-only preview)
  // ============================================================

  registerInitDetectTool(server, service, surface);

  // ============================================================
  // SSA + Admin Surface Tools — registered when surface is 'ssa' or 'admin'
  // ============================================================

  if (surface === 'ssa' || surface === 'admin') {
    server.tool(
      'aegis_list_proposals',
      'List proposals with optional status filter.',
      {
        status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional().describe('Filter by status'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
        offset: z.number().int().min(0).optional().describe('Pagination offset'),
      },
      async (params) => {
        const result = service.listProposals(params, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      'aegis_get_proposal',
      'Get full details of a proposal including evidence.',
      {
        proposal_id: z.string().describe('The proposal ID'),
      },
      async (params) => {
        const result = service.getProposal(params.proposal_id, surface);
        if (!result) {
          return { content: [{ type: 'text', text: `Proposal not found: ${params.proposal_id}` }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      'aegis_archive_observations',
      'Archive observations older than the specified number of days (default: 90).',
      {
        days: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Archive observations older than this many days (default: 90)'),
      },
      async (params) => {
        const result = service.archiveObservations(params.days ?? 90, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    server.tool(
      'aegis_get_stats',
      'Aggregate knowledge counts, compile_log usage metrics, and health signals (stale file-anchored docs, unanalyzed observations, orphaned tag_mappings). Read-only.',
      {},
      async () => {
        const result = service.getStats(surface);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      'aegis_process_observations',
      'Process pending observations through the analyzer pipeline, generating proposals. Per ADR-003: explicit operation (admin and ssa surfaces only).',
      {
        event_type: z
          .enum([
            'compile_miss',
            'review_correction',
            'pr_merged',
            'manual_note',
            'document_import',
            'doc_gap_detected',
            'staleness_detected',
          ])
          .optional()
          .describe('Process only this event type (default: all types)'),
      },
      async (params) => {
        try {
          const result = await service.processObservations(params.event_type, surface);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e: unknown) {
          return toolErrorResult('Processing failed', e);
        }
      },
    );

    server.tool(
      'aegis_sync_docs',
      'Synchronize file-anchored documents with their source files. Detects stale documents via content_hash and creates update_doc proposals. Returns skipped_invalid_anchor for unusable paths (missing, outside project, or resolve errors).',
      {
        doc_ids: z
          .array(z.string())
          .optional()
          .describe(
            'Subset of document IDs to sync. If omitted, syncs all approved documents with ownership=file-anchored.',
          ),
      },
      async (params) => {
        try {
          const result = await service.syncDocs({ doc_ids: params.doc_ids }, surface);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e: unknown) {
          return toolErrorResult('Sync failed', e);
        }
      },
    );
  }

  // ============================================================
  // Admin-only Surface Tools — registered only when surface === 'admin'
  // ============================================================

  if (surface === 'admin') {
    server.tool(
      'aegis_approve_proposal',
      'Approve a pending proposal, applying it to Canonical Knowledge.',
      approveProposalInputShape,
      async (params) => {
        const result = service.approveProposal(params.proposal_id, params.modifications, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    server.tool(
      'aegis_preflight_proposal_bundle',
      'Dry-run all pending proposals sharing a bundle_id: validates ordering and mutations; rolls back (no Canonical change).',
      proposalBundleInputShape,
      async (params) => {
        const result = service.preflightProposalBundle(params.bundle_id, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      'aegis_approve_proposal_bundle',
      'Approve every pending proposal in the bundle in one transaction (one knowledge_version / one snapshot). All-or-nothing.',
      proposalBundleInputShape,
      async (params) => {
        const result = service.approveProposalBundle(params.bundle_id, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    server.tool(
      'aegis_reject_proposal',
      'Reject a pending proposal with a reason.',
      rejectProposalInputShape,
      async (params) => {
        const result = service.rejectProposal(params.proposal_id, params.reason, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    server.tool(
      'aegis_init_confirm',
      'Confirm initialization using a preview hash from init_detect.',
      initConfirmInputShape,
      async (params) => {
        const result = service.initConfirm(params.preview_hash, surface);
        const hint =
          '\n\nNext: run `npx @fuwasegu/aegis deploy-adapters` in the terminal to generate IDE adapter rules (Cursor .mdc, CLAUDE.md, AGENTS.md).';
        return { content: [{ type: 'text', text: JSON.stringify(result) + hint }] };
      },
    );

    server.tool(
      'aegis_check_upgrade',
      'Check if a template upgrade is available for the initialized project.',
      {},
      async () => {
        const result = service.checkUpgrade(surface);
        if (!result) {
          return { content: [{ type: 'text', text: 'Project not initialized.' }], isError: true };
        }
        if ('not_found' in result) {
          const msg =
            result.template_id === 'none'
              ? 'This project was initialized without a template. Template upgrades are not applicable — use aegis_import_doc to manage documents directly.'
              : `Template '${result.template_id}' is no longer bundled. Bundled templates have been removed in favor of aegis_import_doc-based onboarding. Your existing documents are unaffected.`;
          return { content: [{ type: 'text', text: msg }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );

    server.tool(
      'aegis_apply_upgrade',
      'Generate proposals for template upgrade changes. Proposals must still be approved.',
      applyUpgradeInputShape,
      async () => {
        const result = service.applyUpgrade(surface);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    server.tool(
      'aegis_import_doc',
      'Import an existing document into Canonical Knowledge. Creates a document_import observation and generates new_doc/add_edge proposals. Provide content directly or file_path to read from disk.',
      importDocInputShape,
      async (params) => {
        try {
          const result = await service.importDoc(params, surface);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e: unknown) {
          return toolErrorResult('Import failed', e);
        }
      },
    );

    server.tool(
      'aegis_analyze_doc',
      'ADR-015: deterministic import analysis (read-only). Returns ImportPlan with suggested_units, overlap_warnings, coverage_delta. Provide content or file_path.',
      {
        content: z.string().optional().describe('Markdown body (when not using file_path).'),
        file_path: z.string().optional().describe('Absolute path to a markdown file to analyze.'),
        source_label: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Optional provenance label only — never stored as Canonical source_path (use file_path if you need file anchoring).',
          ),
        source_refs: z
          .array(sourceRefSchema)
          .optional()
          .describe('Optional refs echoed on ImportPlan for execute_import_plan (015-10).'),
      },
      async (params) => {
        try {
          const result = service.analyzeDoc(params, surface);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e: unknown) {
          return toolErrorResult('Analyze failed', e);
        }
      },
    );

    server.tool(
      'aegis_analyze_import_batch',
      'ADR-015: batch import analysis — one ImportPlan per item plus cross_doc_overlap between sources.',
      analyzeImportBatchInputShape,
      async (params) => {
        try {
          const result = service.analyzeImportBatch(params, surface);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e: unknown) {
          return toolErrorResult('Batch analyze failed', e);
        }
      },
    );

    server.tool(
      'aegis_execute_import_plan',
      'ADR-015: create document_import-backed proposals sharing one bundle_id (use preflight/approve_proposal_bundle). Pass import_plan or batch_plan JSON from analyze_doc / analyze_import_batch. ' +
        'When resolved_source_path is set from file_path, source_path anchors are attached only if there is exactly one suggested unit whose slice matches the whole file after normalization — ' +
        'otherwise derived/split sections stay standalone; when anchored, stored document content is read from disk so sync_docs hashing matches.',
      executeImportPlanInputShape,
      async (params) => {
        try {
          const result = service.executeImportPlan(params, surface);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e: unknown) {
          return toolErrorResult('execute_import_plan failed', e);
        }
      },
    );

    server.tool(
      'aegis_list_observations',
      'List observations with outcome-based filtering. Per ADR-008: helps admin triage skipped observations. Each row includes `payload` (parsed JSON) for full diagnostics (e.g. doc_gap_detected: scope_patterns, metrics, evidence ids, algorithm_version).',
      {
        event_type: z
          .enum([
            'compile_miss',
            'review_correction',
            'pr_merged',
            'manual_note',
            'document_import',
            'doc_gap_detected',
            'staleness_detected',
          ])
          .optional()
          .describe('Filter by event type'),
        outcome: z
          .enum(['proposed', 'skipped', 'pending'])
          .optional()
          .describe(
            'Filter by outcome: pending (not yet analyzed), proposed (generated proposals), skipped (analyzed but no proposals)',
          ),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
        offset: z.number().int().min(0).optional().describe('Pagination offset'),
      },
      async (params) => {
        const result = service.listObservations(params, surface);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  // ============================================================
  // MCP Resources — Aegis usage guides (ADR-005 D-2)
  // ============================================================

  server.resource('aegis-workflow', 'aegis://guide/workflow', { mimeType: 'text/markdown' }, async () => ({
    contents: [
      {
        uri: 'aegis://guide/workflow',
        mimeType: 'text/markdown',
        text: WORKFLOW_GUIDE,
      },
    ],
  }));

  return server;
}
