import type { AegisDatabase } from './database.js';

export const DEFAULT_SNAPSHOT_RETENTION = 20;
export const SNAPSHOT_RETENTION_ENV = 'AEGIS_SNAPSHOT_RETENTION';

/**
 * Interpret AEGIS_SNAPSHOT_RETENTION. Unset -> default.
 * Only a positive safe integer (/^[1-9][0-9]*$/) is valid; anything else calls warn once and yields the default.
 */
export function resolveSnapshotRetention(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => console.error(m),
): number {
  const raw = env[SNAPSHOT_RETENTION_ENV];
  if (raw === undefined) return DEFAULT_SNAPSHOT_RETENTION;
  if (/^[1-9][0-9]*$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value)) return value;
  }
  warn(
    `[aegis] ${SNAPSHOT_RETENTION_ENV}=${JSON.stringify(raw)} is not a positive integer; using default ${DEFAULT_SNAPSHOT_RETENTION}`,
  );
  return DEFAULT_SNAPSHOT_RETENTION;
}

export interface PruneSnapshotsResult {
  retention: number;
  /** Number of generations whose content rows were deleted. */
  pruned_snapshots: number;
  deleted_rows: { docs: number; edges: number; layer_rules: number };
}

/**
 * Delete snapshot_docs / snapshot_edges / snapshot_layer_rules rows of generations that are neither among the
 * newest `retention` (by knowledge_version) nor referenced by compile_log / observations / init_manifest.
 * The snapshots header rows are kept. Does not open a transaction (call inside the caller's transaction).
 */
export function pruneSnapshots(db: AegisDatabase, retention: number): PruneSnapshotsResult {
  const result: PruneSnapshotsResult = {
    retention,
    pruned_snapshots: 0,
    deleted_rows: { docs: 0, edges: 0, layer_rules: 0 },
  };

  // (1) Early exit: not more generations than the retention.
  const total = (db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n;
  if (total <= retention) return result;

  // (2) Candidates: outside the newest `retention` headers and still holding content rows.
  const candidates = (
    db
      .prepare(
        `SELECT s.snapshot_id AS snapshot_id
         FROM snapshots s
         WHERE s.snapshot_id NOT IN (
                 SELECT snapshot_id FROM snapshots ORDER BY knowledge_version DESC LIMIT ?
               )
           AND (
             EXISTS (SELECT 1 FROM snapshot_docs d WHERE d.snapshot_id = s.snapshot_id)
             OR EXISTS (SELECT 1 FROM snapshot_edges e WHERE e.snapshot_id = s.snapshot_id)
             OR EXISTS (SELECT 1 FROM snapshot_layer_rules r WHERE r.snapshot_id = s.snapshot_id)
           )`,
      )
      .all(retention) as { snapshot_id: string }[]
  ).map((row) => row.snapshot_id);
  if (candidates.length === 0) return result;

  // (3) Referenced generations, built once.
  const referenced = new Set<string>();
  const collect = (rows: { id: string | null }[]): void => {
    for (const row of rows) {
      if (row.id !== null) referenced.add(row.id);
    }
  };
  collect(db.prepare('SELECT DISTINCT snapshot_id AS id FROM compile_log').all() as { id: string | null }[]);
  collect(
    db
      .prepare('SELECT DISTINCT related_snapshot_id AS id FROM observations WHERE related_snapshot_id IS NOT NULL')
      .all() as { id: string | null }[],
  );
  collect(db.prepare('SELECT initial_snapshot_id AS id FROM init_manifest').all() as { id: string | null }[]);

  // (4) Victims are fixed by reads only, then deleted with exactly three statements per victim.
  const victims = candidates.filter((id) => !referenced.has(id));
  if (victims.length === 0) return result;

  const delDocs = db.prepare('DELETE FROM snapshot_docs WHERE snapshot_id = ?');
  const delEdges = db.prepare('DELETE FROM snapshot_edges WHERE snapshot_id = ?');
  const delRules = db.prepare('DELETE FROM snapshot_layer_rules WHERE snapshot_id = ?');
  for (const id of victims) {
    result.deleted_rows.docs += delDocs.run(id).changes;
    result.deleted_rows.edges += delEdges.run(id).changes;
    result.deleted_rows.layer_rules += delRules.run(id).changes;
    result.pruned_snapshots += 1;
  }
  return result;
}

export interface FreelistStats {
  page_count: number;
  freelist_count: number;
  page_size: number;
  /** freelist_count * page_size */
  free_bytes: number;
  /** 0 when page_count === 0, otherwise freelist_count / page_count */
  free_ratio: number;
}

export const COMPACTION_MIN_FREE_BYTES = 1_048_576; // 1 MiB
export const COMPACTION_MIN_FREE_RATIO = 0.25;

function readPragmaNumber(db: AegisDatabase, name: string): number {
  const rows = db.pragma(name) as Record<string, unknown>[];
  const value = rows[0]?.[name];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/** Read-only: derived from PRAGMA page_count / freelist_count / page_size. */
export function inspectFreelist(db: AegisDatabase): FreelistStats {
  const page_count = readPragmaNumber(db, 'page_count');
  const freelist_count = readPragmaNumber(db, 'freelist_count');
  const page_size = readPragmaNumber(db, 'page_size');
  return {
    page_count,
    freelist_count,
    page_size,
    free_bytes: freelist_count * page_size,
    free_ratio: page_count === 0 ? 0 : freelist_count / page_count,
  };
}

export interface DbCompactionReport extends FreelistStats {
  /** free_bytes >= COMPACTION_MIN_FREE_BYTES && free_ratio >= COMPACTION_MIN_FREE_RATIO */
  threshold_met: boolean;
  /** Whether VACUUM actually ran (always false on dry-run). */
  vacuumed: boolean;
}

/**
 * Runs db.exec('VACUUM') only when not dry-run and the threshold is met (call outside a transaction).
 * Reported numbers are the values before VACUUM.
 */
export function compactIfNeeded(db: AegisDatabase, options: { dryRun: boolean }): DbCompactionReport {
  const stats = inspectFreelist(db);
  const threshold_met = stats.free_bytes >= COMPACTION_MIN_FREE_BYTES && stats.free_ratio >= COMPACTION_MIN_FREE_RATIO;
  let vacuumed = false;
  if (!options.dryRun && threshold_met) {
    db.exec('VACUUM');
    vacuumed = true;
  }
  return { ...stats, threshold_met, vacuumed };
}
