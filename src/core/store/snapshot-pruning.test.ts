import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextCompiler } from '../read/compiler.js';
import { type AegisDatabase, createInMemoryDatabase, Repository } from './index.js';
import {
  COMPACTION_MIN_FREE_BYTES,
  COMPACTION_MIN_FREE_RATIO,
  compactIfNeeded,
  DEFAULT_SNAPSHOT_RETENTION,
  inspectFreelist,
  pruneSnapshots,
  resolveSnapshotRetention,
  SNAPSHOT_RETENTION_ENV,
} from './snapshot-pruning.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Seed approved documents / edges / layer rules through the standard bootstrap approval
 * (knowledge_version 0 -> 1) so that every snapshot generation has non-empty content rows.
 */
function seed(repo: Repository, docCount = 2): void {
  const documents = Array.from({ length: docCount }, (_, i) => ({
    doc_id: `doc-${i}`,
    title: `Doc ${i}`,
    kind: 'guideline',
    content: `c${i}`,
    content_hash: hash(`c${i}`),
  }));
  repo.insertProposal({
    proposal_id: 'boot',
    proposal_type: 'bootstrap',
    payload: JSON.stringify({
      documents,
      edges: [
        {
          edge_id: 'e1',
          source_type: 'layer',
          source_value: 'UseCase',
          target_doc_id: 'doc-0',
          edge_type: 'layer_requires',
          priority: 100,
          specificity: 0,
        },
      ],
      layer_rules: [
        { rule_id: 'lr1', path_pattern: 'app/UseCases/**', layer_name: 'UseCase', priority: 100, specificity: 2 },
      ],
    }),
    status: 'pending',
    review_comment: null,
  });
  repo.approveProposal('boot');
}

function bump(repo: Repository, times: number): void {
  for (let i = 0; i < times; i++) {
    repo.bumpVersionAndSnapshot();
  }
}

function countRows(db: AegisDatabase, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

/** Number of snapshot generations that still have rows in snapshot_docs. */
function contentGenerations(db: AegisDatabase): number {
  return countRows(db, 'SELECT COUNT(DISTINCT snapshot_id) AS n FROM snapshot_docs');
}

/** Number of generations that still have rows in any of the three content tables. */
function anyContentGenerations(db: AegisDatabase): number {
  return countRows(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT snapshot_id FROM snapshot_docs
       UNION SELECT snapshot_id FROM snapshot_edges
       UNION SELECT snapshot_id FROM snapshot_layer_rules
     )`,
  );
}

function headerCount(db: AegisDatabase): number {
  return countRows(db, 'SELECT COUNT(*) AS n FROM snapshots');
}

function snapshotIdAtVersion(db: AegisDatabase, version: number): string {
  const row = db.prepare('SELECT snapshot_id FROM snapshots WHERE knowledge_version = ?').get(version) as
    | { snapshot_id: string }
    | undefined;
  if (!row) throw new Error(`no snapshot at knowledge_version ${version}`);
  return row.snapshot_id;
}

function contentRowCounts(db: AegisDatabase, snapshotId: string): { docs: number; edges: number; rules: number } {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE snapshot_id = ?`).get(snapshotId) as { n: number }).n;
  return { docs: count('snapshot_docs'), edges: count('snapshot_edges'), rules: count('snapshot_layer_rules') };
}

function insertCompileLogAt(repo: Repository, compileId: string, snapshotId: string): void {
  repo.insertCompileLog({
    compile_id: compileId,
    snapshot_id: snapshotId,
    request: JSON.stringify({ target_files: ['app/UseCases/Foo.php'] }),
    base_doc_ids: JSON.stringify(['doc-0']),
    expanded_doc_ids: null,
    audit_meta: null,
    agent_id: null,
  });
}

describe('snapshot pruning', () => {
  let db: AegisDatabase;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    savedEnv = process.env[SNAPSHOT_RETENTION_ENV];
    Reflect.deleteProperty(process.env, SNAPSHOT_RETENTION_ENV);
    db = await createInMemoryDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedEnv === undefined) {
      Reflect.deleteProperty(process.env, SNAPSHOT_RETENTION_ENV);
    } else {
      process.env[SNAPSHOT_RETENTION_ENV] = savedEnv;
    }
  });

  // (1) retention
  it('keeps content rows only for the newest `retention` generations and keeps every header', () => {
    const repo = new Repository(db, 5);
    seed(repo);
    bump(repo, 30);

    expect(contentGenerations(db)).toBeLessThanOrEqual(5);
    expect(anyContentGenerations(db)).toBeLessThanOrEqual(5);
    expect(headerCount(db)).toBeGreaterThanOrEqual(30);

    const newest = db.prepare('SELECT snapshot_id FROM snapshots ORDER BY knowledge_version DESC LIMIT 5').all() as {
      snapshot_id: string;
    }[];
    expect(newest).toHaveLength(5);
    for (const { snapshot_id } of newest) {
      const counts = contentRowCounts(db, snapshot_id);
      expect(counts.docs).toBeGreaterThan(0);
      expect(counts.edges).toBeGreaterThan(0);
      expect(counts.rules).toBeGreaterThan(0);
    }
  });

  // (2) referenced generations are retained
  it('retains old generations referenced by compile_log, observations and init_manifest', () => {
    const repo = new Repository(db, 5);
    seed(repo); // v1
    bump(repo, 2); // v2, v3 (3 generations: nothing is pruned yet)
    const viaCompileLog = snapshotIdAtVersion(db, 1);
    const viaObservation = snapshotIdAtVersion(db, 2);
    const viaInitManifest = snapshotIdAtVersion(db, 3);

    insertCompileLogAt(repo, 'compile-ref', viaCompileLog);
    repo.insertObservation({
      observation_id: 'obs-ref',
      event_type: 'manual_note',
      payload: JSON.stringify({ note: 'x' }),
      related_compile_id: null,
      related_snapshot_id: viaObservation,
    });
    repo.insertInitManifest({
      template_id: 't',
      template_version: '1',
      preview_hash: 'h',
      stack_detection: '{}',
      selected_profile: 'p',
      placeholders: '{}',
      initial_snapshot_id: viaInitManifest,
      seed_counts: '{}',
    });

    bump(repo, 30);

    for (const id of [viaCompileLog, viaObservation, viaInitManifest]) {
      const counts = contentRowCounts(db, id);
      expect(counts.docs).toBeGreaterThan(0);
      expect(counts.edges).toBeGreaterThan(0);
      expect(counts.rules).toBeGreaterThan(0);
    }
    // 5 newest + 3 referenced; an unreferenced old generation (v4) has been pruned.
    expect(contentGenerations(db)).toBe(8);
    expect(contentRowCounts(db, snapshotIdAtVersion(db, 4))).toEqual({ docs: 0, edges: 0, rules: 0 });
  });

  // (3) FR-015
  it('returns identical getCompileAudit results before and after pruning (FR-015)', () => {
    const repo = new Repository(db, 5);
    const compiler = new ContextCompiler(repo);
    seed(repo); // v1
    insertCompileLogAt(repo, 'compile-old', snapshotIdAtVersion(db, 1)); // becomes a referenced generation
    bump(repo, 10);
    const currentVersion = repo.getKnowledgeMeta().current_version;
    insertCompileLogAt(repo, 'compile-retained', snapshotIdAtVersion(db, currentVersion)); // retained generation

    const beforeOld = compiler.getCompileAudit('compile-old');
    const beforeRetained = compiler.getCompileAudit('compile-retained');
    expect(beforeOld).toBeDefined();
    expect(beforeRetained).toBeDefined();

    bump(repo, 30);

    expect(compiler.getCompileAudit('compile-old')).toEqual(beforeOld);
    expect(compiler.getCompileAudit('compile-retained')).toEqual(beforeRetained);
  });

  // (4) SC-004
  it('bounds unreferenced generations with content rows to the default retention after 100 approvals (SC-004)', () => {
    const repo = new Repository(db);
    seed(repo);
    bump(repo, 100);

    const unreferenced = countRows(
      db,
      `SELECT COUNT(DISTINCT snapshot_id) AS n FROM snapshot_docs
       WHERE snapshot_id NOT IN (SELECT snapshot_id FROM compile_log)
         AND snapshot_id NOT IN (SELECT related_snapshot_id FROM observations WHERE related_snapshot_id IS NOT NULL)
         AND snapshot_id NOT IN (SELECT initial_snapshot_id FROM init_manifest)`,
    );
    expect(unreferenced).toBeLessThanOrEqual(20);
    expect(headerCount(db)).toBeGreaterThanOrEqual(100);
  });

  // (5) early return
  it('returns immediately without touching compile_log when the generation count is within retention', () => {
    const repo = new Repository(db, 5);
    seed(repo);
    bump(repo, 2);
    expect(headerCount(db)).toBeLessThanOrEqual(5);

    const spy = vi.spyOn(db, 'prepare');
    const result = pruneSnapshots(db, 5);

    expect(result.retention).toBe(5);
    expect(result.pruned_snapshots).toBe(0);
    expect(result.deleted_rows).toEqual({ docs: 0, edges: 0, layer_rules: 0 });
    const sqls = spy.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((sql) => sql.includes('compile_log'))).toBe(false);
  });

  // (6) env resolution
  describe('resolveSnapshotRetention', () => {
    it('exposes the default of 20', () => {
      expect(DEFAULT_SNAPSHOT_RETENTION).toBe(20);
    });

    it('returns the configured positive integer', () => {
      const warn = vi.fn<(message: string) => void>();
      expect(resolveSnapshotRetention({ [SNAPSHOT_RETENTION_ENV]: '7' }, warn)).toBe(7);
      expect(warn).not.toHaveBeenCalled();
    });

    it('returns the default without a warning when unset', () => {
      const warn = vi.fn<(message: string) => void>();
      expect(resolveSnapshotRetention({}, warn)).toBe(20);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(['0', '-1', 'abc', '1.5', ''])('warns once and falls back to 20 for %j', (value) => {
      const warn = vi.fn<(message: string) => void>();
      expect(resolveSnapshotRetention({ [SNAPSHOT_RETENTION_ENV]: value }, warn)).toBe(20);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  // (7) failure isolation
  it('does not fail the approval when pruning throws, and logs the failure', () => {
    const repo = new Repository(db, 3);
    seed(repo);
    bump(repo, 6); // enough generations that the next approval has pruning candidates

    const original = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('DELETE FROM snapshot_docs')) {
        throw new Error('injected pruning failure');
      }
      return original(sql);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const versionBefore = repo.getKnowledgeMeta().current_version;

    const result = repo.bumpVersionAndSnapshot();

    expect(result.knowledge_version).toBe(versionBefore + 1);
    expect(repo.getKnowledgeMeta().current_version).toBe(versionBefore + 1);
    expect(repo.getSnapshotById(result.snapshot_id)).toBeDefined();
    expect(contentRowCounts(db, result.snapshot_id).docs).toBeGreaterThan(0);
    expect(errorSpy).toHaveBeenCalledWith('[aegis] snapshot pruning failed:', expect.any(Error));
  });

  // (8) compaction (FR-016). Verified via PRAGMA page_count / freelist_count (inspectFreelist);
  // AegisDatabase has no public export().
  describe('compaction', () => {
    /**
     * Many generations over many documents, built with a retention too large to prune, then pruned
     * in one go. Pruning incrementally would let later inserts reuse the freed pages, so the
     * freelist would never accumulate. Document bodies are kept short on purpose: snapshot rows hold
     * only hashes, and bulky `documents.content` would dilute free_ratio below the threshold.
     */
    function buildBloatedDatabase(): void {
      const repo = new Repository(db, 10_000);
      seed(repo, 300);
      bump(repo, 30);
      pruneSnapshots(db, 3);
    }

    it('reports a freelist above the compaction threshold after pruning many generations', () => {
      buildBloatedDatabase();
      const stats = inspectFreelist(db);
      expect(stats.free_bytes).toBeGreaterThan(0);
      expect(stats.free_ratio).toBeGreaterThan(0);
      expect(stats.free_bytes).toBe(stats.freelist_count * stats.page_size);
      expect(stats.free_bytes).toBeGreaterThanOrEqual(COMPACTION_MIN_FREE_BYTES);
      expect(stats.free_ratio).toBeGreaterThanOrEqual(COMPACTION_MIN_FREE_RATIO);
    });

    it('dry-run reports threshold_met without vacuuming or changing the database', () => {
      buildBloatedDatabase();
      const before = inspectFreelist(db);

      const report = compactIfNeeded(db, { dryRun: true });

      expect(report.threshold_met).toBe(true);
      expect(report.vacuumed).toBe(false);
      expect(report.page_count).toBe(before.page_count);
      expect(report.freelist_count).toBe(before.freelist_count);
      const after = inspectFreelist(db);
      expect(after.page_count).toBe(before.page_count);
      expect(after.freelist_count).toBe(before.freelist_count);
    });

    it('vacuums when the threshold is met, shrinking the database and reporting pre-VACUUM values', () => {
      buildBloatedDatabase();
      const before = inspectFreelist(db);

      const report = compactIfNeeded(db, { dryRun: false });

      expect(report.threshold_met).toBe(true);
      expect(report.vacuumed).toBe(true);
      // Reported numbers are the values before VACUUM.
      expect(report.page_count).toBe(before.page_count);
      expect(report.freelist_count).toBe(before.freelist_count);
      expect(report.free_bytes).toBe(before.free_bytes);

      const after = inspectFreelist(db);
      expect(after.freelist_count).toBe(0);
      expect(after.page_count).toBeLessThan(before.page_count);
    });

    it('does not vacuum a fresh database below the threshold', async () => {
      const fresh = await createInMemoryDatabase();
      const before = inspectFreelist(fresh);

      for (const dryRun of [true, false]) {
        const report = compactIfNeeded(fresh, { dryRun });
        expect(report.threshold_met).toBe(false);
        expect(report.vacuumed).toBe(false);
      }
      expect(inspectFreelist(fresh).page_count).toBe(before.page_count);
    });
  });
});
