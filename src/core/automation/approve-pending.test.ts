import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAegisServer } from '../../mcp/server.js';
import { AegisService, SURFACES, type Surface, SurfaceViolationError } from '../../mcp/services.js';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../store/index.js';
import type { ProposalType } from '../types.js';
import { type ApprovePendingResult, approvePendingProposals, parseProposalTypesOption } from './approve-pending.js';

const TEMPLATES_ROOT = join(import.meta.dirname, '../../../templates');

const ALLOWED_TYPES = 'bootstrap,new_doc,update_doc,add_edge,retarget_edge,remove_edge,deprecate,materialize';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface Fixture {
  db: AegisDatabase;
  repo: Repository;
}

async function createFixture(): Promise<Fixture> {
  const db = await createInMemoryDatabase();
  return { db, repo: new Repository(db) };
}

/** Initializes the knowledge base with one approved document ('base-doc') via an approved bootstrap proposal. */
function seedBaseKnowledge({ repo }: Fixture): void {
  repo.insertProposal({
    proposal_id: 'p-boot',
    proposal_type: 'bootstrap',
    payload: JSON.stringify({
      documents: [
        {
          doc_id: 'base-doc',
          title: 'Base Doc',
          kind: 'guideline',
          content: 'base content',
          content_hash: hash('base content'),
        },
      ],
      edges: [
        {
          edge_id: 'e-base',
          source_type: 'path',
          source_value: 'app/**',
          target_doc_id: 'base-doc',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 2,
        },
      ],
      layer_rules: [],
    }),
    status: 'pending',
    review_comment: null,
    bundle_id: null,
  });
  repo.approveProposal('p-boot');
}

function setCreatedAt({ db }: Fixture, proposalId: string, createdAt: string): void {
  db.prepare('UPDATE proposals SET created_at = ? WHERE proposal_id = ?').run(createdAt, proposalId);
}

function insertPending(
  fx: Fixture,
  proposalId: string,
  proposalType: ProposalType,
  payload: Record<string, unknown>,
  createdAt: string,
  bundleId: string | null = null,
): void {
  fx.repo.insertProposal({
    proposal_id: proposalId,
    proposal_type: proposalType,
    payload: JSON.stringify(payload),
    status: 'pending',
    review_comment: null,
    bundle_id: bundleId,
  });
  setCreatedAt(fx, proposalId, createdAt);
}

function newDocPayload(docId: string): Record<string, unknown> {
  return {
    doc_id: docId,
    title: `Title ${docId}`,
    kind: 'guideline',
    content: `content of ${docId}`,
    content_hash: hash(`content of ${docId}`),
  };
}

function addEdgePayload(edgeId: string, targetDocId: string, sourceValue = 'src/**/*.ts'): Record<string, unknown> {
  return {
    edge_id: edgeId,
    source_type: 'path',
    source_value: sourceValue,
    target_doc_id: targetDocId,
    edge_type: 'path_requires',
    priority: 100,
    specificity: 2,
  };
}

/**
 * Seeds three pending proposals (new_doc, update_doc, add_edge) on top of the base knowledge.
 * created_at is deliberately inverted (add_edge is the oldest) so that the type order, not the age, drives the result.
 * The add_edge proposal has a compile_miss observation as evidence.
 */
function seedThreePending(fx: Fixture): void {
  seedBaseKnowledge(fx);
  fx.repo.insertObservation({
    observation_id: 'obs-1',
    event_type: 'compile_miss',
    payload: '{}',
    related_compile_id: null,
    related_snapshot_id: null,
  });
  insertPending(fx, 'p-edge', 'add_edge', addEdgePayload('e-new', 'base-doc'), '2026-01-01T00:00:01.000Z');
  fx.repo.insertProposalEvidence('p-edge', 'obs-1');
  insertPending(
    fx,
    'p-update',
    'update_doc',
    { doc_id: 'base-doc', content: 'updated content', content_hash: hash('updated content') },
    '2026-01-01T00:00:02.000Z',
  );
  insertPending(fx, 'p-new', 'new_doc', newDocPayload('new-doc'), '2026-01-01T00:00:03.000Z');
}

function pendingIds({ repo }: Fixture): string[] {
  return repo
    .listProposals('pending', 1000)
    .proposals.map((p) => p.proposal_id)
    .sort();
}

function snapshotCount({ db }: Fixture): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM snapshots').get() as { c: number }).c;
}

function statusOf({ repo }: Fixture, proposalId: string): string | undefined {
  return repo.getProposal(proposalId)?.status;
}

function canonicalDocs({ repo }: Fixture) {
  return repo
    .getApprovedDocuments()
    .map((d) => ({
      doc_id: d.doc_id,
      title: d.title,
      kind: d.kind,
      content: d.content,
      content_hash: d.content_hash,
      status: d.status,
    }))
    .sort((a, b) => a.doc_id.localeCompare(b.doc_id));
}

function canonicalEdges({ repo }: Fixture) {
  return repo
    .getApprovedEdges()
    .map((e) => ({
      edge_id: e.edge_id,
      source_type: e.source_type,
      source_value: e.source_value,
      target_doc_id: e.target_doc_id,
      edge_type: e.edge_type,
      priority: e.priority,
      specificity: e.specificity,
      status: e.status,
    }))
    .sort((a, b) => a.edge_id.localeCompare(b.edge_id));
}

describe('approvePendingProposals', () => {
  let fx: Fixture;
  let projectRoot: string;

  beforeEach(async () => {
    fx = await createFixture();
    projectRoot = mkdtempSync(join(tmpdir(), 'aegis-approve-pending-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // (1)(2)
  it('dry-run lists the three pending proposals in type order without changing the DB', () => {
    seedThreePending(fx);
    expect(pendingIds(fx)).toEqual(['p-edge', 'p-new', 'p-update']);
    const versionBefore = fx.repo.getKnowledgeMeta().current_version;
    const snapshotsBefore = snapshotCount(fx);

    const result = approvePendingProposals(fx.repo, { dryRun: true, types: null }, projectRoot);

    expect(result.dry_run).toBe(true);
    expect(result.would_approve.map((i) => i.proposal_id)).toEqual(['p-new', 'p-update', 'p-edge']);
    expect(result.would_approve.map((i) => i.proposal_type)).toEqual(['new_doc', 'update_doc', 'add_edge']);
    expect(result.approved).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.pending_total).toBe(3);
    expect(result.selected).toBe(3);
    expect(result.knowledge_version).toBe(versionBefore);

    expect(pendingIds(fx)).toEqual(['p-edge', 'p-new', 'p-update']);
    expect(statusOf(fx, 'p-new')).toBe('pending');
    expect(statusOf(fx, 'p-update')).toBe('pending');
    expect(statusOf(fx, 'p-edge')).toBe('pending');
    expect(fx.repo.getKnowledgeMeta().current_version).toBe(versionBefore);
    expect(snapshotCount(fx)).toBe(snapshotsBefore);
  });

  // (3)
  it('approves only the requested types and leaves the rest pending', () => {
    seedThreePending(fx);

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: ['add_edge'] }, projectRoot);

    expect(result.types).toEqual(['add_edge']);
    expect(result.approved.map((i) => i.proposal_id)).toEqual(['p-edge']);
    expect(result.selected).toBe(1);
    expect(result.pending_total).toBe(3);
    expect(result.failed).toEqual([]);
    expect(statusOf(fx, 'p-edge')).toBe('approved');
    expect(pendingIds(fx)).toEqual(['p-new', 'p-update']);
  });

  // (4)
  it('approves all pending proposals and reports version, snapshot, edge info and evidence', () => {
    seedThreePending(fx);

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.dry_run).toBe(false);
    expect(result.types).toBeNull();
    expect(result.pending_total).toBe(3);
    expect(result.selected).toBe(3);
    expect(result.would_approve).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.approved.map((i) => i.proposal_id)).toEqual(['p-new', 'p-update', 'p-edge']);
    for (const item of result.approved) {
      expect(typeof item.knowledge_version).toBe('number');
      expect(item.snapshot_id).toEqual(expect.any(String));
      expect(item.snapshot_id).not.toBe('');
    }
    const versions = result.approved.map((i) => i.knowledge_version);
    expect(new Set(versions).size).toBe(3);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);

    const edgeItem = result.approved.find((i) => i.proposal_type === 'add_edge');
    expect(edgeItem).toBeDefined();
    expect(edgeItem?.doc_id).toBe('base-doc');
    expect(edgeItem?.edge).toEqual({
      source_type: 'path',
      source_value: 'src/**/*.ts',
      target_doc_id: 'base-doc',
      edge_type: 'path_requires',
    });
    expect(edgeItem?.evidence_event_types).toEqual(['compile_miss']);
    expect(edgeItem?.summary).toBe('add_edge path:src/**/*.ts -> base-doc (path_requires)');

    const newDocItem = result.approved.find((i) => i.proposal_type === 'new_doc');
    expect(newDocItem?.doc_id).toBe('new-doc');
    expect(newDocItem?.edge).toBeNull();
    expect(newDocItem?.evidence_event_types).toEqual([]);

    expect(pendingIds(fx)).toEqual([]);
    expect(result.knowledge_version).toBe(fx.repo.getKnowledgeMeta().current_version);
    expect(result.knowledge_version).toBe(versions[versions.length - 1]);
  });

  // (5)
  it('is equivalent to calling repo.approveProposal sequentially (FR-009)', async () => {
    seedThreePending(fx);
    const other = await createFixture();
    seedThreePending(other);

    approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);
    for (const id of ['p-new', 'p-update', 'p-edge']) {
      other.repo.approveProposal(id, undefined, projectRoot);
    }

    expect(canonicalDocs(fx)).toEqual(canonicalDocs(other));
    expect(canonicalEdges(fx)).toEqual(canonicalEdges(other));
    expect(fx.repo.getKnowledgeMeta().current_version).toBe(other.repo.getKnowledgeMeta().current_version);
    expect(snapshotCount(fx)).toBe(snapshotCount(other));
  });

  // (6)
  it('skips bundled proposals in both dry-run and execution', () => {
    seedBaseKnowledge(fx);
    insertPending(fx, 'p-b1', 'new_doc', newDocPayload('doc-b1'), '2026-01-01T00:00:01.000Z', 'bundle-1');
    insertPending(fx, 'p-b2', 'new_doc', newDocPayload('doc-b2'), '2026-01-01T00:00:02.000Z', 'bundle-1');
    const versionBefore = fx.repo.getKnowledgeMeta().current_version;

    for (const dryRun of [true, false]) {
      const result = approvePendingProposals(fx.repo, { dryRun, types: null }, projectRoot);
      expect(result.pending_total).toBe(2);
      expect(result.selected).toBe(2);
      expect(result.approved).toEqual([]);
      expect(result.would_approve).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.skipped.map((s) => s.proposal_id).sort()).toEqual(['p-b1', 'p-b2']);
      for (const s of result.skipped) {
        expect(s.reason).toBe('bundled');
        expect(s.detail).toBe('bundle bundle-1: use aegis_approve_proposal_bundle');
      }
      expect(pendingIds(fx)).toEqual(['p-b1', 'p-b2']);
      expect(fx.repo.getKnowledgeMeta().current_version).toBe(versionBefore);
    }
  });

  // (7)
  it('records a failure, keeps approving the rest and logs to console.error', () => {
    seedThreePending(fx);
    insertPending(
      fx,
      'p-bad-edge',
      'add_edge',
      addEdgePayload('e-bad', 'no-such-doc', 'lib/**'),
      '2026-01-01T00:00:04.000Z',
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.pending_total).toBe(4);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].proposal_id).toBe('p-bad-edge');
    expect(typeof result.failed[0].error).toBe('string');
    expect(result.failed[0].error.length).toBeGreaterThan(0);
    expect(result.approved.map((i) => i.proposal_id)).toEqual(['p-new', 'p-update', 'p-edge']);
    expect(statusOf(fx, 'p-new')).toBe('approved');
    expect(statusOf(fx, 'p-update')).toBe('approved');
    expect(statusOf(fx, 'p-edge')).toBe('approved');
    expect(statusOf(fx, 'p-bad-edge')).toBe('pending');
    expect(errorSpy).toHaveBeenCalled();
  });

  // (8)
  it('returns empty lists when nothing is pending', () => {
    seedBaseKnowledge(fx);

    for (const dryRun of [true, false]) {
      const result = approvePendingProposals(fx.repo, { dryRun, types: null }, projectRoot);
      expect(result.approved).toEqual([]);
      expect(result.would_approve).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.pending_total).toBe(0);
      expect(result.selected).toBe(0);
    }
  });

  // (10)
  it('orders by created_at ascending within a type, then by proposal_id for equal timestamps', () => {
    seedBaseKnowledge(fx);
    insertPending(fx, 'p-2', 'new_doc', newDocPayload('doc-2'), '2026-01-01T00:00:05.000Z');
    insertPending(fx, 'p-1', 'new_doc', newDocPayload('doc-1'), '2026-01-01T00:00:05.000Z');
    insertPending(fx, 'p-3', 'new_doc', newDocPayload('doc-3'), '2026-01-01T00:00:01.000Z');

    expect(fx.repo.listPendingProposalsOrdered(null).map((p) => p.proposal_id)).toEqual(['p-3', 'p-1', 'p-2']);

    const dry = approvePendingProposals(fx.repo, { dryRun: true, types: null }, projectRoot);
    expect(dry.would_approve.map((i) => i.proposal_id)).toEqual(['p-3', 'p-1', 'p-2']);

    const run = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);
    expect(run.approved.map((i) => i.proposal_id)).toEqual(['p-3', 'p-1', 'p-2']);
  });

  // Edge Case: another process approves a proposal after the pending list was read.
  it('skips a proposal approved by another process with reason no_longer_pending and approves the other', () => {
    seedBaseKnowledge(fx);
    insertPending(fx, 'p-a', 'new_doc', newDocPayload('doc-a'), '2026-01-01T00:00:01.000Z');
    insertPending(fx, 'p-b', 'new_doc', newDocPayload('doc-b'), '2026-01-01T00:00:02.000Z');

    // The list still contains p-a (stale snapshot), while another path approves it just before execution.
    const stale = fx.repo.listPendingProposalsOrdered(null);
    expect(stale.map((p) => p.proposal_id)).toEqual(['p-a', 'p-b']);
    vi.spyOn(fx.repo, 'listPendingProposalsOrdered').mockReturnValue(stale);
    const externalVersion = fx.repo.approveProposal('p-a', undefined, projectRoot);
    const approveSpy = vi.spyOn(fx.repo, 'approveProposal');

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].proposal_id).toBe('p-a');
    expect(result.skipped[0].reason).toBe('no_longer_pending');
    expect(result.skipped[0].detail).toBe('status: approved');
    expect(result.failed).toEqual([]);
    expect(result.approved.map((i) => i.proposal_id)).toEqual(['p-b']);
    expect(approveSpy).toHaveBeenCalledTimes(1);
    expect(approveSpy).toHaveBeenCalledWith('p-b', undefined, projectRoot);
    expect(result.approved[0].knowledge_version).toBe(externalVersion.knowledge_version + 1);
    expect(result.knowledge_version).toBe(externalVersion.knowledge_version + 1);
    expect(fx.repo.getKnowledgeMeta().current_version).toBe(externalVersion.knowledge_version + 1);
    expect(statusOf(fx, 'p-a')).toBe('approved');
    expect(statusOf(fx, 'p-b')).toBe('approved');
  });

  it('skips (not fails) a proposal approved by another process between the status check and the transaction', () => {
    seedBaseKnowledge(fx);
    insertPending(fx, 'p-race', 'new_doc', newDocPayload('doc-race'), '2026-01-01T00:00:01.000Z');
    const realApprove = fx.repo.approveProposal.bind(fx.repo);
    // Another process wins the race: it approves first, then our transaction rejects the now non-pending proposal.
    vi.spyOn(fx.repo, 'approveProposal').mockImplementationOnce((id, mods, root) => {
      realApprove(id, mods, root);
      throw new Error(`Proposal ${id} is not pending`);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.failed).toEqual([]);
    expect(result.approved).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].proposal_id).toBe('p-race');
    expect(result.skipped[0].reason).toBe('no_longer_pending');
    expect(result.skipped[0].detail).toBe('status: approved');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('skips a proposal that no longer exists with detail "proposal no longer exists"', () => {
    seedBaseKnowledge(fx);
    insertPending(fx, 'p-gone', 'new_doc', newDocPayload('doc-gone'), '2026-01-01T00:00:01.000Z');
    vi.spyOn(fx.repo, 'getProposal').mockReturnValue(undefined);
    const approveSpy = vi.spyOn(fx.repo, 'approveProposal');
    const versionBefore = fx.repo.getKnowledgeMeta().current_version;

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].proposal_id).toBe('p-gone');
    expect(result.skipped[0].reason).toBe('no_longer_pending');
    expect(result.skipped[0].detail).toBe('proposal no longer exists');
    expect(result.approved).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(approveSpy).not.toHaveBeenCalled();
    expect(result.knowledge_version).toBe(versionBefore);
  });
});

describe('Repository.listPendingProposalsOrdered', () => {
  it('filters by type and excludes non-pending proposals', async () => {
    const fx = await createFixture();
    seedBaseKnowledge(fx);
    insertPending(fx, 'p-n', 'new_doc', newDocPayload('doc-n'), '2026-01-01T00:00:01.000Z');
    insertPending(fx, 'p-e', 'add_edge', addEdgePayload('e-x', 'base-doc'), '2026-01-01T00:00:02.000Z');

    expect(fx.repo.listPendingProposalsOrdered(['add_edge']).map((p) => p.proposal_id)).toEqual(['p-e']);
    expect(fx.repo.listPendingProposalsOrdered(null).map((p) => p.proposal_id)).toEqual(['p-n', 'p-e']);

    fx.repo.approveProposal('p-n');
    expect(fx.repo.listPendingProposalsOrdered(null).map((p) => p.proposal_id)).toEqual(['p-e']);
  });
});

// (9)
describe('AegisService.approvePending — INV-6', () => {
  it('throws SurfaceViolationError on the agent surface and returns a result on admin', async () => {
    const fx = await createFixture();
    seedThreePending(fx);
    const service = new AegisService(fx.repo, TEMPLATES_ROOT);

    expect(() => service.approvePending({ dryRun: true, types: null }, 'agent')).toThrow(SurfaceViolationError);

    const result: ApprovePendingResult = service.approvePending({ dryRun: true, types: null }, 'admin');
    expect(result.dry_run).toBe(true);
    expect(result.would_approve).toHaveLength(3);
    expect(pendingIds(fx)).toEqual(['p-edge', 'p-new', 'p-update']);
  });

  it('keeps the MCP tool counts at 6 (agent), 12 (ssa), and 24 (admin) with no approve_pending tool', async () => {
    const fx = await createFixture();
    const service = new AegisService(fx.repo, TEMPLATES_ROOT);

    const counts: Record<Surface, number> = { agent: 6, ssa: 12, admin: 24 };
    for (const surface of SURFACES) {
      const server = createAegisServer(service, surface);
      const client = new Client({ name: `test-client-${surface}`, version: '0.0.1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toHaveLength(counts[surface]);
      expect(names.some((n) => n.includes('approve_pending'))).toBe(false);

      await client.close();
      await server.close();
    }
  });
});

describe('approvePendingProposals: update_doc selection', () => {
  let fx: Fixture;
  let projectRoot: string;

  beforeEach(async () => {
    fx = await createFixture();
    projectRoot = mkdtempSync(join(tmpdir(), 'aegis-approve-pending-upd-'));
    seedBaseKnowledge(fx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function updatePayload(content: string, sourcePath?: string): Record<string, unknown> {
    const payload: Record<string, unknown> = { doc_id: 'base-doc', content, content_hash: hash(content) };
    if (sourcePath !== undefined) payload.source_path = sourcePath;
    return payload;
  }

  /** Inserts an update_doc proposal whose evidence is an already-analyzed document_import observation. */
  function insertUpdate(id: string, content: string, createdAt: string, sourcePath?: string): void {
    const obsId = `obs-${id}`;
    fx.repo.insertObservation({
      observation_id: obsId,
      event_type: 'document_import',
      payload: '{}',
      related_compile_id: null,
      related_snapshot_id: null,
    });
    fx.db.prepare('UPDATE observations SET analyzed_at = ? WHERE observation_id = ?').run(createdAt, obsId);
    insertPending(fx, id, 'update_doc', updatePayload(content, sourcePath), createdAt);
    fx.repo.insertProposalEvidence(id, obsId);
  }

  function writeSource(rel: string, content: string): void {
    mkdirSync(join(projectRoot, rel, '..'), { recursive: true });
    writeFileSync(join(projectRoot, rel), content, 'utf-8');
  }

  function baseContent(): string | undefined {
    return fx.repo.getDocumentById('base-doc')?.content;
  }

  it('approves only the newest update_doc per document and rejects older ones as superseded', () => {
    insertUpdate('p-u1', 'v1', '2026-01-01T00:00:01.000Z');
    insertUpdate('p-u2', 'v2', '2026-01-01T00:00:02.000Z');
    insertUpdate('p-u3', 'v3', '2026-01-01T00:00:03.000Z');

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.approved.map((i) => i.proposal_id)).toEqual(['p-u3']);
    expect(result.rejected.map((i) => [i.proposal_id, i.reason])).toEqual([
      ['p-u1', 'superseded'],
      ['p-u2', 'superseded'],
    ]);
    expect(result.rejected[0].detail).toBe('superseded by p-u3');
    expect(result.failed).toEqual([]);
    expect(baseContent()).toBe('v3');
    expect(statusOf(fx, 'p-u1')).toBe('rejected');
    expect(fx.repo.getProposal('p-u1')?.review_comment).toContain('superseded by p-u3');
    // Evidence stays analyzed so the next maintenance run does not recreate the proposal.
    expect(fx.repo.getObservation('obs-p-u1')?.analyzed_at).not.toBeNull();
  });

  it('rejects the newest update_doc as stale_content when it differs from the anchored source file', () => {
    writeSource('docs/base.md', 'current file');
    insertUpdate('p-old', 'old v1', '2026-01-01T00:00:01.000Z', 'docs/base.md');
    insertUpdate('p-new', 'old v2', '2026-01-01T00:00:02.000Z', 'docs/base.md');

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.approved).toEqual([]);
    expect(result.rejected.map((i) => [i.proposal_id, i.reason])).toEqual([
      ['p-old', 'superseded'],
      ['p-new', 'stale_content'],
    ]);
    expect(result.rejected[1].detail).toContain('docs/base.md');
    expect(baseContent()).toBe('base content');
    expect(fx.repo.listProposals('pending', 10).total).toBe(0);
  });

  it('approves the newest update_doc when it matches the anchored source file', () => {
    writeSource('docs/base.md', 'current file');
    insertUpdate('p-old', 'old v1', '2026-01-01T00:00:01.000Z', 'docs/base.md');
    insertUpdate('p-new', 'current file', '2026-01-01T00:00:02.000Z', 'docs/base.md');

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.approved.map((i) => i.proposal_id)).toEqual(['p-new']);
    expect(result.rejected.map((i) => i.proposal_id)).toEqual(['p-old']);
    expect(baseContent()).toBe('current file');
  });

  it('approves the newest update_doc when the anchored file does not exist (cannot verify)', () => {
    insertUpdate('p-new', 'v1', '2026-01-01T00:00:01.000Z', 'docs/missing.md');

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.approved.map((i) => i.proposal_id)).toEqual(['p-new']);
    expect(result.rejected).toEqual([]);
  });

  it('dry-run reports would_reject and leaves every proposal pending', () => {
    writeSource('docs/base.md', 'current file');
    insertUpdate('p-old', 'old v1', '2026-01-01T00:00:01.000Z', 'docs/base.md');
    insertUpdate('p-new', 'old v2', '2026-01-01T00:00:02.000Z', 'docs/base.md');

    const result = approvePendingProposals(fx.repo, { dryRun: true, types: null }, projectRoot);

    expect(result.would_approve).toEqual([]);
    expect(result.would_reject.map((i) => [i.proposal_id, i.reason])).toEqual([
      ['p-old', 'superseded'],
      ['p-new', 'stale_content'],
    ]);
    expect(result.rejected).toEqual([]);
    expect(pendingIds(fx)).toEqual(['p-new', 'p-old']);
  });
});

describe('approvePendingProposals: duplicate add_edge', () => {
  let fx: Fixture;
  let projectRoot: string;

  beforeEach(async () => {
    fx = await createFixture();
    projectRoot = mkdtempSync(join(tmpdir(), 'aegis-approve-pending-dup-'));
    seedBaseKnowledge(fx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Inserts an add_edge proposal whose evidence is an already-analyzed document_import observation. */
  function insertEdge(id: string, edgeId: string, sourceValue: string, createdAt: string): void {
    const obsId = `obs-${id}`;
    fx.repo.insertObservation({
      observation_id: obsId,
      event_type: 'document_import',
      payload: '{}',
      related_compile_id: null,
      related_snapshot_id: null,
    });
    fx.db.prepare('UPDATE observations SET analyzed_at = ? WHERE observation_id = ?').run(createdAt, obsId);
    insertPending(fx, id, 'add_edge', addEdgePayload(edgeId, 'base-doc', sourceValue), createdAt);
    fx.repo.insertProposalEvidence(id, obsId);
  }

  function insertFiveDuplicates(): void {
    for (let i = 1; i <= 5; i++) {
      insertEdge(`p-dup${i}`, `e-dup${i}`, 'app/**', `2026-01-01T00:00:0${i}.000Z`);
    }
  }

  it('rejects an add_edge that collides with an approved edge as duplicate_edge', () => {
    insertEdge('p-dup', 'e-dup', 'app/**', '2026-01-01T00:00:01.000Z');

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.approved).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.rejected.map((i) => [i.proposal_id, i.reason])).toEqual([['p-dup', 'duplicate_edge']]);
    expect(result.rejected[0].detail).toContain('e-base');
    expect(statusOf(fx, 'p-dup')).toBe('rejected');
    expect(fx.repo.getProposal('p-dup')?.review_comment).toContain('duplicate_edge');
    // Evidence stays analyzed so the next maintenance run does not recreate the proposal.
    expect(fx.repo.getObservation('obs-p-dup')?.analyzed_at).not.toBeNull();
    expect(canonicalEdges(fx).map((e) => e.edge_id)).not.toContain('e-dup');
  });

  it('dry-run reports would_reject for a colliding add_edge and leaves it pending', () => {
    insertEdge('p-dup', 'e-dup', 'app/**', '2026-01-01T00:00:01.000Z');

    const result = approvePendingProposals(fx.repo, { dryRun: true, types: null }, projectRoot);

    expect(result.would_approve).toEqual([]);
    expect(result.would_reject.map((i) => [i.proposal_id, i.reason])).toEqual([['p-dup', 'duplicate_edge']]);
    expect(result.would_reject[0].detail).toContain('e-base');
    expect(result.rejected).toEqual([]);
    expect(pendingIds(fx)).toEqual(['p-dup']);
  });

  it('approves an add_edge whose routing key differs from every approved edge', () => {
    insertEdge('p-other', 'e-other', 'lib/**', '2026-01-01T00:00:01.000Z');

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.approved.map((i) => i.proposal_id)).toEqual(['p-other']);
    expect(result.rejected).toEqual([]);
    expect(canonicalEdges(fx).map((e) => e.edge_id)).toContain('e-other');
  });

  it('approves the first of five add_edges for a new key and rejects the other four', () => {
    insertFiveDuplicates();
    // Same key as the five proposals, but not yet approved: the first one is approved, the rest collide with it.
    fx.db.prepare("UPDATE proposals SET payload = REPLACE(payload, 'app/**', 'srv/**')").run();

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.approved.map((i) => i.proposal_id)).toEqual(['p-dup1']);
    expect(result.rejected.map((i) => [i.proposal_id, i.reason])).toEqual([
      ['p-dup2', 'duplicate_edge'],
      ['p-dup3', 'duplicate_edge'],
      ['p-dup4', 'duplicate_edge'],
      ['p-dup5', 'duplicate_edge'],
    ]);
    expect(result.rejected.every((i) => i.detail.includes('e-dup1'))).toBe(true);
    expect(result.failed).toEqual([]);
    expect(fx.repo.listProposals('pending', 10).total).toBe(0);
  });

  it('dry-run classifies the same five add_edges as one would_approve and four would_reject', () => {
    insertFiveDuplicates();
    fx.db.prepare("UPDATE proposals SET payload = REPLACE(payload, 'app/**', 'srv/**')").run();

    const result = approvePendingProposals(fx.repo, { dryRun: true, types: null }, projectRoot);

    expect(result.would_approve.map((i) => i.proposal_id)).toEqual(['p-dup1']);
    expect(result.would_reject.map((i) => i.proposal_id)).toEqual(['p-dup2', 'p-dup3', 'p-dup4', 'p-dup5']);
    expect(result.would_reject.every((i) => i.detail.includes('e-dup1'))).toBe(true);
    expect(result.rejected).toEqual([]);
    expect(pendingIds(fx)).toHaveLength(5);
  });

  it('rejects all five add_edges when they collide with an approved edge', () => {
    insertFiveDuplicates();

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.approved).toEqual([]);
    expect(result.rejected).toHaveLength(5);
    expect(result.rejected.every((i) => i.reason === 'duplicate_edge' && i.detail.includes('e-base'))).toBe(true);
    expect(result.failed).toEqual([]);
  });

  it('does not reject a colliding add_edge while a pending remove_edge targets the approved edge', () => {
    insertEdge('p-dup', 'e-dup', 'app/**', '2026-01-01T00:00:01.000Z');
    insertPending(fx, 'p-rm', 'remove_edge', { edge_id: 'e-base' }, '2026-01-01T00:00:02.000Z');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = approvePendingProposals(fx.repo, { dryRun: false, types: null }, projectRoot);

    expect(result.rejected).toEqual([]);
    expect(result.failed.map((i) => i.proposal_id)).toEqual(['p-dup']);
    expect(result.approved.map((i) => i.proposal_id)).toEqual(['p-rm']);
    expect(statusOf(fx, 'p-dup')).toBe('pending');
    expect(errorSpy).toHaveBeenCalled();
  });
});

// (11)
describe('parseProposalTypesOption', () => {
  it('parses a comma-separated list in the given order', () => {
    expect(parseProposalTypesOption('new_doc,add_edge')).toEqual(['new_doc', 'add_edge']);
    expect(parseProposalTypesOption('add_edge')).toEqual(['add_edge']);
  });

  it.each(['foo', '', 'new_doc,'])('rejects %j and lists the allowed values', (raw) => {
    expect(() => parseProposalTypesOption(raw)).toThrow(Error);
    expect(() => parseProposalTypesOption(raw)).toThrow(ALLOWED_TYPES);
  });
});
