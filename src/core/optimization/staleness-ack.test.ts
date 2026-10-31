import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AegisService, SurfaceViolationError } from '../../mcp/services.js';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../store/index.js';
import { collectSemanticStalenessFindings } from './staleness.js';
import { acknowledgeStaleness } from './staleness-ack.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  }
}

function pathEdge(edgeId: string, glob: string, targetDocId: string): Record<string, unknown> {
  return {
    edge_id: edgeId,
    source_type: 'path',
    source_value: glob,
    target_doc_id: targetDocId,
    edge_type: 'path_requires',
    priority: 100,
    specificity: 0,
  };
}

/** doc-a ← src/**, doc-b ← lib/**, doc-c has no path edge. */
function bootstrap(repo: Repository): void {
  const doc = (id: string): Record<string, unknown> => ({
    doc_id: id,
    title: id,
    kind: 'guideline',
    content: id,
    content_hash: hash(id),
  });
  repo.insertProposal({
    proposal_id: 'p-boot',
    proposal_type: 'bootstrap',
    payload: JSON.stringify({
      documents: [doc('doc-a'), doc('doc-b'), doc('doc-c')],
      edges: [pathEdge('e-a', 'src/**', 'doc-a'), pathEdge('e-b', 'lib/**', 'doc-b')],
      layer_rules: [],
    }),
    status: 'pending',
    review_comment: null,
  });
  repo.approveProposal('p-boot');
}

function scan(repo: Repository, root: string): ReturnType<typeof collectSemanticStalenessFindings> {
  return collectSemanticStalenessFindings({
    docs: repo.getApprovedDocuments(),
    edges: repo.getApprovedEdges(),
    projectRoot: root,
    getBaseline: (id) => repo.getStalenessBaseline(id),
    persistLevel3Baselines: true,
  });
}

/** Inserts an observation the way maintenance records a finding. */
function observe(repo: Repository, id: string, docId: string, level: number, kind: string): void {
  repo.insertObservation({
    observation_id: id,
    event_type: 'staleness_detected',
    payload: JSON.stringify({ doc_id: docId, level, kind, detail: 'x', algorithm_version: 1 }),
    related_compile_id: null,
    related_snapshot_id: null,
  });
}

function archivedAt(db: AegisDatabase, id: string): string | null {
  const row = db.prepare('SELECT archived_at FROM observations WHERE observation_id = ?').get(id) as {
    archived_at: string | null;
  };
  return row.archived_at;
}

describe('acknowledgeStaleness (CLI staleness-ack)', () => {
  let root: string;
  let db: AegisDatabase;
  let repo: Repository;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-stale-ack-'));
    writeFiles(root, {
      'src/a.ts': 'export function A() {}\n',
      'lib/b.ts': 'export function B() {}\n',
    });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    bootstrap(repo);
    // First maintenance-equivalent run captures the baselines.
    for (const u of scan(repo, root).baselineUpserts) repo.upsertStalenessBaseline(u.doc_id, u.fingerprint_json);

    // Code drift under both docs, reported and recorded as observations.
    writeFiles(root, {
      'src/a.ts': 'export function A() {}\nexport function A2() {}\n',
      'src/new.ts': 'export const N = 1;\n',
      'lib/b.ts': 'export function B2() {}\n',
    });
    observe(repo, 'o-a3', 'doc-a', 3, 'linked_file_added');
    observe(repo, 'o-a1', 'doc-a', 1, 'hash_mismatch');
    observe(repo, 'o-b3', 'doc-b', 3, 'symbol_drift');
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('re-captures the baseline so the acknowledged drift is no longer reported, and archives Level-3 observations', () => {
    const before = scan(repo, root);
    expect(before.findings.filter((f) => f.doc_id === 'doc-a').length).toBeGreaterThan(0);
    const baselineB = repo.getStalenessBaseline('doc-b');

    const result = acknowledgeStaleness(repo, root, { docIds: ['doc-a'], dryRun: false });

    expect(result.dry_run).toBe(false);
    expect(result.skipped).toEqual([]);
    expect(result.acknowledged).toHaveLength(1);
    expect(result.acknowledged[0].doc_id).toBe('doc-a');
    expect(result.acknowledged[0].findings.linked_file_added).toBe(1);
    expect(result.acknowledged[0].baseline_path_count).toBe(2);
    expect(result.archived_observations).toBe(1);

    const after = scan(repo, root);
    expect(after.findings.filter((f) => f.doc_id === 'doc-a')).toEqual([]);
    // A drift-free scan refreshes the baseline; it must equal what ack stored.
    expect(after.baselineUpserts.find((u) => u.doc_id === 'doc-a')?.fingerprint_json).toBe(
      repo.getStalenessBaseline('doc-a'),
    );
    // doc-b was not acknowledged: still drifting, baseline untouched.
    expect(after.findings.some((f) => f.doc_id === 'doc-b')).toBe(true);
    expect(repo.getStalenessBaseline('doc-b')).toBe(baselineB);

    expect(archivedAt(db, 'o-a3')).not.toBeNull();
    expect(archivedAt(db, 'o-a1')).toBeNull(); // Level 1 is resolved by sync_docs, not ack.
    expect(archivedAt(db, 'o-b3')).toBeNull();
  });

  it('dry-run reports the same counts without writing', () => {
    const baselineA = repo.getStalenessBaseline('doc-a');

    const result = acknowledgeStaleness(repo, root, { docIds: ['doc-a'], dryRun: true });

    expect(result.dry_run).toBe(true);
    expect(result.acknowledged[0].findings.linked_file_added).toBe(1);
    expect(result.archived_observations).toBe(1);
    expect(repo.getStalenessBaseline('doc-a')).toBe(baselineA);
    expect(archivedAt(db, 'o-a3')).toBeNull();
  });

  it('--all acknowledges every document with linked paths and skips the rest', () => {
    const result = acknowledgeStaleness(repo, root, { docIds: null, dryRun: false });

    expect(result.acknowledged.map((a) => a.doc_id).sort()).toEqual(['doc-a', 'doc-b']);
    expect(result.skipped).toEqual([{ doc_id: 'doc-c', reason: 'no_linked_paths' }]);
    expect(result.archived_observations).toBe(2);
    expect(scan(repo, root).findings).toEqual([]);
  });

  it('rejects an unknown doc_id before writing anything', () => {
    const baselineA = repo.getStalenessBaseline('doc-a');

    expect(() => acknowledgeStaleness(repo, root, { docIds: ['doc-a', 'nope'], dryRun: false })).toThrow(/nope/);

    expect(repo.getStalenessBaseline('doc-a')).toBe(baselineA);
    expect(archivedAt(db, 'o-a3')).toBeNull();
  });

  it('is admin-only on the service', () => {
    const service = new AegisService(repo, join(import.meta.dirname, '../../../templates'), null, [], false, root);
    expect(() => service.ackStaleness({ docIds: null, dryRun: true }, 'agent')).toThrow(SurfaceViolationError);
  });
});
