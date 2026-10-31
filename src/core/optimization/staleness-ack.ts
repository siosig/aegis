/**
 * Acknowledges Level-3 semantic staleness (CLI `staleness-ack`).
 *
 * `maintenance` refreshes a document's Level-3 baseline only on a run with no drift, so a reported drift stays
 * reported until something resets the baseline. After a human has confirmed that a document still matches the
 * drifted code, this re-captures the baseline from the current files and archives the document's Level-3
 * `staleness_detected` observations. Levels 1–2 (document vs. its source file) are not affected; `sync_docs`
 * resolves them.
 */

import type { Repository } from '../store/repository.js';
import type { Document } from '../types.js';
import { collectSemanticStalenessFindings } from './staleness.js';

export interface StalenessAckOptions {
  /** Approved doc_ids to acknowledge, or null for every approved document. */
  docIds: readonly string[] | null;
  dryRun: boolean;
}

export interface StalenessAckDocResult {
  doc_id: string;
  /** Level-3 findings against the previous baseline, counted by kind (what is being acknowledged). */
  findings: Record<string, number>;
  /** Number of paths in the re-captured baseline. */
  baseline_path_count: number;
}

export type StalenessAckSkipReason = 'no_linked_paths' | 'source_unreadable';

export interface StalenessAckResult {
  dry_run: boolean;
  acknowledged: StalenessAckDocResult[];
  skipped: Array<{ doc_id: string; reason: StalenessAckSkipReason }>;
  /** Archived (or, with dry_run, archivable) Level-3 `staleness_detected` observations. */
  archived_observations: number;
}

function selectDocs(approved: Document[], docIds: readonly string[] | null): Document[] {
  if (docIds === null) return approved;
  const byId = new Map(approved.map((d) => [d.doc_id, d]));
  const unknown = docIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`not approved documents: ${unknown.join(', ')}`);
  }
  return [...new Set(docIds)].map((id) => byId.get(id) as Document);
}

function countLevel3ByKind(
  findings: ReadonlyArray<{ doc_id: string; level: number; kind: string }>,
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const f of findings) {
    if (f.level !== 3) continue;
    const counts = out.get(f.doc_id) ?? {};
    counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    out.set(f.doc_id, counts);
  }
  return out;
}

export function acknowledgeStaleness(
  repo: Repository,
  projectRoot: string,
  options: StalenessAckOptions,
): StalenessAckResult {
  const docs = selectDocs(repo.getApprovedDocuments(), options.docIds);
  const edges = repo.getApprovedEdges();

  // Pass 1: what the current baselines report (read-only).
  const before = collectSemanticStalenessFindings({
    docs,
    edges,
    projectRoot,
    getBaseline: (id) => repo.getStalenessBaseline(id),
    persistLevel3Baselines: false,
  });
  // Pass 2: a baseline is captured for every doc whose previous baseline reads as absent.
  const recaptured = collectSemanticStalenessFindings({
    docs,
    edges,
    projectRoot,
    getBaseline: () => null,
    persistLevel3Baselines: true,
  });

  const findingsByDoc = countLevel3ByKind(before.findings);
  const unreadable = new Set(before.findings.filter((f) => f.kind === 'source_unreadable').map((f) => f.doc_id));
  const upsertByDoc = new Map(recaptured.baselineUpserts.map((u) => [u.doc_id, u.fingerprint_json]));

  const acknowledged: StalenessAckDocResult[] = [];
  const skipped: StalenessAckResult['skipped'] = [];
  for (const doc of docs) {
    const json = upsertByDoc.get(doc.doc_id);
    if (json === undefined) {
      skipped.push({
        doc_id: doc.doc_id,
        reason: unreadable.has(doc.doc_id) ? 'source_unreadable' : 'no_linked_paths',
      });
      continue;
    }
    acknowledged.push({
      doc_id: doc.doc_id,
      findings: findingsByDoc.get(doc.doc_id) ?? {},
      baseline_path_count: Object.keys(JSON.parse(json) as Record<string, string>).length,
    });
  }

  const ackIds = acknowledged.map((a) => a.doc_id);
  if (options.dryRun) {
    return {
      dry_run: true,
      acknowledged,
      skipped,
      archived_observations: repo.countUnarchivedLevel3StalenessObservationsForDocs(ackIds),
    };
  }

  const archived = repo.runInTransactionReturn(() => {
    for (const id of ackIds) {
      repo.upsertStalenessBaseline(id, upsertByDoc.get(id) as string);
    }
    return repo.archiveLevel3StalenessObservationsForDocs(ackIds);
  });
  return { dry_run: false, acknowledged, skipped, archived_observations: archived };
}
