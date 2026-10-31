/**
 * Bulk approval of pending proposals (CLI `approve-pending`).
 *
 * Approves pending proposals one by one in a fixed type order, skipping bundled proposals
 * (those require `aegis_approve_proposal_bundle`). Each approval runs in its own transaction
 * via `Repository.approveProposal`; a failure does not roll back earlier successes.
 *
 * update_doc: per doc_id only the newest proposal is a candidate. Older ones are rejected as
 * `superseded`. The newest one is rejected as `stale_content` when the document resolves to a
 * whole-file source anchor whose current file content differs from the proposed content
 * (approving it would roll the document back to an older version). Rejections keep the evidence
 * observations analyzed so the next maintenance run does not recreate the same proposals.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolveSourcePath } from '../paths.js';
import { primaryAssetPathForHashSync } from '../source-refs.js';
import type { Repository } from '../store/repository.js';
import type { CanonicalVersion, Proposal, ProposalType } from '../types.js';

/** Approval order (first to last). Within a type: created_at ASC, then proposal_id ASC. */
export const APPROVE_PENDING_TYPE_ORDER: readonly ProposalType[] = [
  'bootstrap',
  'new_doc',
  'update_doc',
  'add_edge',
  'retarget_edge',
  'remove_edge',
  'deprecate',
  'materialize',
] as const;

export interface ApprovePendingOptions {
  /** When true, the DB is not modified; only the targets and their order are returned. */
  dryRun: boolean;
  /** Proposal types to process. null means all types. */
  types: ProposalType[] | null;
}

export interface ApprovePendingEdgeInfo {
  source_type: string;
  source_value: string;
  target_doc_id: string;
  edge_type: string;
}

export interface ApprovePendingItem {
  proposal_id: string;
  proposal_type: ProposalType;
  /**
   * new_doc / update_doc: payload.doc_id; add_edge: payload.target_doc_id;
   * deprecate: payload.entity_id when payload.entity_type === 'document'. Otherwise (or unparsable) null.
   */
  doc_id: string | null;
  /** Non-null only for add_edge (from the payload). */
  edge: ApprovePendingEdgeInfo | null;
  /** event_type of the evidence observations (deduplicated, ascending). [] when there is no evidence. */
  evidence_event_types: string[];
  /** One-line summary for humans; not for machine processing. */
  summary: string;
}

export interface ApprovePendingApproved extends ApprovePendingItem {
  knowledge_version: number;
  snapshot_id: string;
}

export interface ApprovePendingSkipped extends ApprovePendingItem {
  reason: 'bundled' | 'no_longer_pending';
  detail: string;
}

export interface ApprovePendingRejected extends ApprovePendingItem {
  reason: 'superseded' | 'stale_content';
  detail: string;
}

export interface ApprovePendingFailed extends ApprovePendingItem {
  /** Error.message (Error.name when empty). The stack goes to stderr. */
  error: string;
}

export interface ApprovePendingResult {
  dry_run: boolean;
  /** Requested types (null when all types). */
  types: ProposalType[] | null;
  /** Number of pending proposals before the run (before narrowing by type). */
  pending_total: number;
  /** Number of proposals after narrowing by type (bundled included). */
  selected: number;
  approved: ApprovePendingApproved[]; // [] on dry run
  would_approve: ApprovePendingItem[]; // non-empty only on dry run, in processing order
  /** update_doc proposals rejected as superseded / stale_content. [] on dry run. */
  rejected: ApprovePendingRejected[];
  /** Same classification as `rejected`, non-empty only on dry run (the DB is not modified). */
  would_reject: ApprovePendingRejected[];
  skipped: ApprovePendingSkipped[];
  failed: ApprovePendingFailed[]; // [] on dry run
  /** knowledge_version after the run (the current value on dry run). */
  knowledge_version: number;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractDocId(proposalType: ProposalType, payload: Record<string, unknown> | null): string | null {
  if (payload === null) return null;
  switch (proposalType) {
    case 'new_doc':
    case 'update_doc':
      return asString(payload.doc_id);
    case 'add_edge':
      return asString(payload.target_doc_id);
    case 'deprecate':
      return payload.entity_type === 'document' ? asString(payload.entity_id) : null;
    default:
      return null;
  }
}

function extractEdge(
  proposalType: ProposalType,
  payload: Record<string, unknown> | null,
): ApprovePendingEdgeInfo | null {
  if (proposalType !== 'add_edge' || payload === null) return null;
  const source_type = asString(payload.source_type);
  const source_value = asString(payload.source_value);
  const target_doc_id = asString(payload.target_doc_id);
  const edge_type = asString(payload.edge_type);
  if (source_type === null || source_value === null || target_doc_id === null || edge_type === null) return null;
  return { source_type, source_value, target_doc_id, edge_type };
}

function buildItem(repo: Repository, proposal: Proposal): ApprovePendingItem {
  const payload = parsePayload(proposal.payload);
  const doc_id = extractDocId(proposal.proposal_type, payload);
  const edge = extractEdge(proposal.proposal_type, payload);
  const evidence_event_types = [...new Set(repo.getProposalEvidence(proposal.proposal_id).map((o) => o.event_type))]
    .map(String)
    .sort();

  let summary: string;
  if (edge !== null) {
    summary = `add_edge ${edge.source_type}:${edge.source_value} -> ${edge.target_doc_id} (${edge.edge_type})`;
  } else if (doc_id !== null) {
    summary = `${proposal.proposal_type} ${doc_id}`;
  } else {
    summary = `${proposal.proposal_type} ${proposal.proposal_id}`;
  }

  return {
    proposal_id: proposal.proposal_id,
    proposal_type: proposal.proposal_type,
    doc_id,
    edge,
    evidence_event_types,
    summary,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

type Rejection = Pick<ApprovePendingRejected, 'reason' | 'detail'>;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Hash of the current whole-file source of the document as it would be after approving `payload`
 * (payload anchor fields override the stored document). null when there is no whole-file anchor,
 * the path is invalid, or the file does not exist (the proposal cannot be verified, so it is not rejected).
 */
function currentSourceHash(
  repo: Repository,
  docId: string,
  payload: Record<string, unknown>,
  projectRoot: string,
): { path: string; hash: string } | null {
  const doc = repo.getDocumentById(docId);
  const pick = (key: 'source_path' | 'source_refs_json'): string | null => {
    const value = key in payload ? payload[key] : doc?.[key];
    return typeof value === 'string' ? value : null;
  };
  const path = primaryAssetPathForHashSync({
    source_path: pick('source_path'),
    source_refs_json: pick('source_refs_json'),
  });
  if (path === null || path.trim() === '') return null;
  try {
    const absPath = resolveSourcePath(path.trim(), projectRoot);
    if (!existsSync(absPath)) return null;
    return { path: path.trim(), hash: sha256(readFileSync(absPath, 'utf-8')) };
  } catch {
    // Invalid anchor (outside the project, unreadable): leave the decision to the approval itself.
    return null;
  }
}

/** Rejection for the newest update_doc of a document, or null when it may be approved. */
function staleContentRejection(repo: Repository, proposal: Proposal, projectRoot: string): Rejection | null {
  const payload = parsePayload(proposal.payload);
  const docId = payload === null ? null : asString(payload.doc_id);
  const content = payload === null ? null : asString(payload.content);
  if (payload === null || docId === null || content === null) return null;
  const source = currentSourceHash(repo, docId, payload, projectRoot);
  if (source === null) return null;
  const proposed = sha256(content);
  if (proposed === source.hash) return null;
  return {
    reason: 'stale_content',
    detail: `content does not match ${source.path} (proposal ${proposed.slice(0, 12)}, file ${source.hash.slice(0, 12)})`,
  };
}

/**
 * Classifies non-bundled update_doc proposals (in processing order): per doc_id, all but the
 * newest are `superseded`; the newest is `stale_content` when it differs from the current source file.
 */
function classifyUpdateDocs(repo: Repository, ordered: Proposal[], projectRoot: string): Map<string, Rejection> {
  const newestByDoc = new Map<string, Proposal>();
  for (const p of ordered) {
    if (p.proposal_type !== 'update_doc' || p.bundle_id != null) continue;
    const docId = extractDocId(p.proposal_type, parsePayload(p.payload));
    if (docId !== null) newestByDoc.set(docId, p); // later in order = newer
  }
  const rejections = new Map<string, Rejection>();
  for (const p of ordered) {
    if (p.proposal_type !== 'update_doc' || p.bundle_id != null) continue;
    const docId = extractDocId(p.proposal_type, parsePayload(p.payload));
    const newest = docId === null ? undefined : newestByDoc.get(docId);
    if (newest === undefined) continue;
    if (newest.proposal_id !== p.proposal_id) {
      rejections.set(p.proposal_id, { reason: 'superseded', detail: `superseded by ${newest.proposal_id}` });
      continue;
    }
    const stale = staleContentRejection(repo, p, projectRoot);
    if (stale !== null) rejections.set(p.proposal_id, stale);
  }
  return rejections;
}

function noLongerPending(repo: Repository, item: ApprovePendingItem): ApprovePendingSkipped | null {
  const fresh = repo.getProposal(item.proposal_id);
  if (fresh !== undefined && fresh.status === 'pending') return null;
  return {
    ...item,
    reason: 'no_longer_pending',
    detail: fresh === undefined ? 'proposal no longer exists' : `status: ${fresh.status}`,
  };
}

interface Buckets {
  approved: ApprovePendingApproved[];
  would_approve: ApprovePendingItem[];
  rejected: ApprovePendingRejected[];
  would_reject: ApprovePendingRejected[];
  skipped: ApprovePendingSkipped[];
  failed: ApprovePendingFailed[];
}

/** Applies one decision (approve or reject) to a still-pending proposal and records the outcome. */
function applyDecision(
  repo: Repository,
  item: ApprovePendingItem,
  rejection: Rejection | undefined,
  projectRoot: string,
  out: Buckets,
): void {
  const gone = noLongerPending(repo, item);
  if (gone !== null) {
    out.skipped.push(gone);
    return;
  }
  try {
    if (rejection !== undefined) {
      repo.rejectProposal(item.proposal_id, `approve-pending: ${rejection.reason}: ${rejection.detail}`, {
        reanalyzeEvidence: false,
      });
      out.rejected.push({ ...item, ...rejection });
      return;
    }
    const version: CanonicalVersion = repo.approveProposal(item.proposal_id, undefined, projectRoot);
    out.approved.push({ ...item, knowledge_version: version.knowledge_version, snapshot_id: version.snapshot_id });
  } catch (err) {
    // Another process may have resolved it between the status check and the write.
    const raced = noLongerPending(repo, item);
    if (raced !== null) {
      out.skipped.push(raced);
      return;
    }
    console.error(`[aegis] approve-pending: ${item.proposal_id} failed:`, err);
    out.failed.push({ ...item, error: errorMessage(err) });
  }
}

/**
 * Skips bundled proposals, rejects superseded / stale update_doc proposals, and approves the rest
 * in order via repo.approveProposal(id, undefined, projectRoot).
 */
export function approvePendingProposals(
  repo: Repository,
  options: ApprovePendingOptions,
  projectRoot: string,
): ApprovePendingResult {
  const pending_total = repo.listProposals('pending', 1).total;
  const typeIndex = (t: ProposalType): number => APPROVE_PENDING_TYPE_ORDER.indexOf(t);
  // Array.prototype.sort is stable, so created_at / proposal_id order is kept within a type.
  const proposals = repo
    .listPendingProposalsOrdered(options.types)
    .map((p, i) => ({ p, i }))
    .sort((a, b) => typeIndex(a.p.proposal_type) - typeIndex(b.p.proposal_type) || a.i - b.i)
    .map(({ p }) => p);
  const rejections = classifyUpdateDocs(repo, proposals, projectRoot);

  const out: Buckets = { approved: [], would_approve: [], rejected: [], would_reject: [], skipped: [], failed: [] };
  for (const proposal of proposals) {
    const item = buildItem(repo, proposal);
    if (proposal.bundle_id != null) {
      out.skipped.push({
        ...item,
        reason: 'bundled',
        detail: `bundle ${proposal.bundle_id}: use aegis_approve_proposal_bundle`,
      });
      continue;
    }
    const rejection = rejections.get(proposal.proposal_id);
    if (options.dryRun) {
      if (rejection !== undefined) out.would_reject.push({ ...item, ...rejection });
      else out.would_approve.push(item);
      continue;
    }
    applyDecision(repo, item, rejection, projectRoot, out);
  }

  return {
    dry_run: options.dryRun,
    types: options.types,
    pending_total,
    selected: proposals.length,
    approved: out.approved,
    would_approve: out.would_approve,
    rejected: out.rejected,
    would_reject: out.would_reject,
    skipped: out.skipped,
    failed: out.failed,
    knowledge_version: repo.getKnowledgeMeta().current_version,
  };
}

/** Parses the `--types` value (comma separated). Throws on empty or unknown elements. */
export function parseProposalTypesOption(raw: string): ProposalType[] {
  const allowed = APPROVE_PENDING_TYPE_ORDER.join(',');
  const result: ProposalType[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (name === '') {
      throw new Error(`Invalid --types value '${raw}': empty element. Allowed types: ${allowed}`);
    }
    const type = APPROVE_PENDING_TYPE_ORDER.find((t) => t === name);
    if (type === undefined) {
      throw new Error(`Invalid --types value: unknown proposal type '${name}'. Allowed types: ${allowed}`);
    }
    if (!result.includes(type)) result.push(type);
  }
  return result;
}
