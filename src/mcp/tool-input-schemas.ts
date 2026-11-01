import { z } from 'zod';

/**
 * MCP ツールの入力スキーマ（zod の raw shape）。
 * `src/mcp/server.ts` のツールの登録と `src/cli/admin-commands.ts` の CLI が共有する。
 */

/** ADR-015 §015-10 の source_refs の要素。 */
export const sourceRefSchema = z
  .object({
    asset_path: z.string(),
    anchor_type: z.enum(['file', 'section', 'lines']),
    anchor_value: z.string().optional().default(''),
  })
  .refine((r) => r.anchor_type === 'file' || (typeof r.anchor_value === 'string' && r.anchor_value.trim() !== ''), {
    message: 'anchor_value is required when anchor_type is section or lines',
  });

export const importDocInputShape = {
  content: z.string().optional().describe('Document content (Markdown body). Either content or file_path is required.'),
  file_path: z
    .string()
    .optional()
    .describe('Absolute path to a file to read as document content. Takes priority over content.'),
  doc_id: z.string().describe('Document ID (lowercase alphanumeric, hyphens, underscores)'),
  title: z.string().describe('Document title'),
  kind: z.enum(['guideline', 'pattern', 'constraint', 'template', 'reference']).describe('Document kind'),
  edge_hints: z
    .array(
      z.object({
        source_type: z.enum(['path', 'layer', 'command', 'doc']),
        source_value: z.string(),
        edge_type: z.enum(['path_requires', 'layer_requires', 'command_requires', 'doc_depends_on']),
        priority: z.number().int().optional(),
      }),
    )
    .optional()
    .describe('DAG edge hints for connecting the document'),
  tags: z.array(z.string()).optional().describe('Tags for tag_mappings (applied on approve)'),
  source_path: z
    .string()
    .optional()
    .describe('Original file path (provenance metadata). Auto-set from file_path if not provided.'),
  source_refs: z
    .array(sourceRefSchema)
    .optional()
    .describe(
      'ADR-015 §015-10: repo asset references for N:M mapping (stored as documents.source_refs_json on approve).',
    ),
};

export const analyzeImportBatchInputShape = {
  items: z
    .array(
      z.object({
        content: z.string().optional(),
        file_path: z.string().optional(),
        source_label: z.string().nullable().optional(),
        source_refs: z.array(sourceRefSchema).optional(),
      }),
    )
    .describe('Non-empty list of documents to analyze (each needs content or file_path).'),
};

export const executeImportPlanInputShape = {
  import_plan: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Single-document ImportPlan object (mutually exclusive with batch_plan).'),
  batch_plan: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('BatchImportPlan object from analyze_import_batch.'),
  bundle_id: z.string().optional().describe('Optional bundle id (UUID generated when omitted).'),
};

export const initDetectInputShape = {
  project_root: z.string().describe('Absolute path to the project root directory'),
  skip_template: z
    .boolean()
    .optional()
    .describe('Skip template detection and create an empty knowledge base. Use aegis_import_doc to add documents.'),
};

export const initConfirmInputShape = {
  preview_hash: z.string().describe('The preview_hash from a prior init_detect call'),
};

export const applyUpgradeInputShape = {};

export const rejectProposalInputShape = {
  proposal_id: z.string().describe('The proposal ID to reject'),
  reason: z.string().describe('Reason for rejection'),
};

/** aegis_preflight_proposal_bundle と aegis_approve_proposal_bundle が共有する。 */
export const proposalBundleInputShape = {
  bundle_id: z.string().describe('The bundle_id shared by pending proposals'),
};

export const approveProposalInputShape = {
  proposal_id: z.string().describe('The proposal ID to approve'),
  modifications: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Optional modifications to the proposal payload before approval'),
};
