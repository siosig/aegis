/**
 * Bulk approval of pending proposals (CLI `approve-pending`).
 *
 * Approves pending proposals one by one in a fixed type order, skipping bundled proposals
 * (those require `aegis_approve_proposal_bundle`). Each approval runs in its own transaction
 * via `Repository.approveProposal`; a failure does not roll back earlier successes.
 */

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

/** Skips bundled proposals and approves the rest in order via repo.approveProposal(id, undefined, projectRoot). */
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

  const approved: ApprovePendingApproved[] = [];
  const would_approve: ApprovePendingItem[] = [];
  const skipped: ApprovePendingSkipped[] = [];
  const failed: ApprovePendingFailed[] = [];

  for (const proposal of proposals) {
    const item = buildItem(repo, proposal);

    if (proposal.bundle_id != null) {
      skipped.push({
        ...item,
        reason: 'bundled',
        detail: `bundle ${proposal.bundle_id}: use aegis_approve_proposal_bundle`,
      });
      continue;
    }

    if (options.dryRun) {
      would_approve.push(item);
      continue;
    }

    const fresh = repo.getProposal(proposal.proposal_id);
    if (fresh === undefined || fresh.status !== 'pending') {
      skipped.push({
        ...item,
        reason: 'no_longer_pending',
        detail: fresh === undefined ? 'proposal no longer exists' : `status: ${fresh.status}`,
      });
      continue;
    }

    try {
      const version: CanonicalVersion = repo.approveProposal(proposal.proposal_id, undefined, projectRoot);
      approved.push({ ...item, knowledge_version: version.knowledge_version, snapshot_id: version.snapshot_id });
    } catch (err) {
      // Another process may have approved it between the status check and the transaction.
      const after = repo.getProposal(proposal.proposal_id);
      if (after === undefined || after.status !== 'pending') {
        skipped.push({
          ...item,
          reason: 'no_longer_pending',
          detail: after === undefined ? 'proposal no longer exists' : `status: ${after.status}`,
        });
        continue;
      }
      console.error(`[aegis] approve-pending: ${proposal.proposal_id} failed:`, err);
      failed.push({ ...item, error: errorMessage(err) });
    }
  }

  return {
    dry_run: options.dryRun,
    types: options.types,
    pending_total,
    selected: proposals.length,
    approved,
    would_approve,
    skipped,
    failed,
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
