import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../store/index.js';
import { collectSemanticStalenessFindings, docSourcePathSet } from './staleness.js';
import { buildStalenessReport } from './staleness-report.js';

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
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

/** doc-a ← src/**, doc-b ← lib/**, doc-c ← conf/**. */
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
      edges: [
        pathEdge('e-a', 'src/**', 'doc-a'),
        pathEdge('e-b', 'lib/**', 'doc-b'),
        pathEdge('e-c', 'conf/**', 'doc-c'),
      ],
      layer_rules: [],
    }),
    status: 'pending',
    review_comment: null,
  });
  repo.approveProposal('p-boot');
}

/** What a maintenance run with no drift persists: the current fingerprints as each doc's baseline. */
function captureBaselines(repo: Repository, root: string): void {
  const r = collectSemanticStalenessFindings({
    docs: repo.getApprovedDocuments(),
    edges: repo.getApprovedEdges(),
    projectRoot: root,
    getBaseline: (id) => repo.getStalenessBaseline(id),
    persistLevel3Baselines: true,
    excludedLinkedPaths: docSourcePathSet(repo.getApprovedDocuments()),
  });
  for (const u of r.baselineUpserts) repo.upsertStalenessBaseline(u.doc_id, u.fingerprint_json);
}

describe('buildStalenessReport (CLI staleness-report)', () => {
  let gitRoot: string;
  let db: AegisDatabase;
  let repo: Repository;
  let c0: string;

  async function setUp(projectSubdir: string): Promise<string> {
    gitRoot = mkdtempSync(join(tmpdir(), 'aegis-stale-report-'));
    const root = projectSubdir === '' ? gitRoot : join(gitRoot, projectSubdir);
    writeFiles(root, {
      'src/a.ts': 'export function A() {}\n',
      'lib/b.ts': 'export function B() {}\n',
    });
    git(gitRoot, 'init', '-q');
    c0 = commitAll(gitRoot, 'c0');
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    bootstrap(repo);
    captureBaselines(repo, root);
    return root;
  }

  afterEach(() => {
    db?.close();
    rmSync(gitRoot, { recursive: true, force: true });
  });

  describe('at the git top level', () => {
    let root: string;
    beforeEach(async () => {
      root = await setUp('');
    });

    it('reports nothing when no linked file changed', () => {
      const r = buildStalenessReport(repo, root, { docIds: null, baseRef: 'HEAD', headRef: null });
      expect(r.base_ref).toBe(c0);
      expect(r.head_ref).toBeNull();
      expect(r.documents).toEqual([]);
    });

    it('attributes findings of a commit range when the baseline equals the base and the files equal the head', () => {
      writeFiles(root, {
        'src/a.ts': 'export function A() {}\nexport function A2() {}\n',
        'src/new.ts': 'export const N = 1;\n',
        'lib/c.ts': 'export function C() {}\n',
      });
      unlinkSync(join(root, 'lib/b.ts'));
      const c1 = commitAll(root, 'c1');

      const r = buildStalenessReport(repo, root, { docIds: null, baseRef: c0, headRef: 'HEAD' });

      expect(r.base_ref).toBe(c0);
      expect(r.head_ref).toBe(c1);
      expect(r.documents.map((d) => d.doc_id)).toEqual(['doc-a', 'doc-b']);
      const a = r.documents[0]!;
      expect(a.all_attributable).toBe(true);
      expect(a.findings.map((f) => [f.kind, f.path, f.attributable])).toEqual([
        ['symbol_drift', 'src/a.ts', true],
        ['linked_file_added', 'src/new.ts', true],
      ]);
      expect(r.documents[1]!.findings.map((f) => [f.kind, f.path, f.attributable])).toEqual([
        ['linked_file_removed', 'lib/b.ts', true],
        ['linked_file_added', 'lib/c.ts', true],
      ]);
    });

    it('attributes uncommitted changes against HEAD when no head ref is given (pre-commit review)', () => {
      writeFiles(root, { 'src/a.ts': 'export function Renamed() {}\n' });
      const r = buildStalenessReport(repo, root, { docIds: null, baseRef: 'HEAD', headRef: null });
      expect(r.documents).toHaveLength(1);
      expect(r.documents[0]!.all_attributable).toBe(true);
    });

    it('does not attribute a change that an earlier commit outside the range made', () => {
      writeFiles(root, { 'src/a.ts': 'export function Earlier() {}\n' });
      const c1 = commitAll(root, 'plain commit, never acknowledged');
      writeFiles(root, { 'src/later.ts': 'export const L = 1;\n' });
      commitAll(root, 'c2');

      const r = buildStalenessReport(repo, root, { docIds: null, baseRef: c1, headRef: 'HEAD' });

      const a = r.documents.find((d) => d.doc_id === 'doc-a')!;
      expect(a.all_attributable).toBe(false);
      expect(a.findings.map((f) => [f.path, f.attributable])).toEqual([
        ['src/a.ts', false],
        ['src/later.ts', true],
      ]);
    });

    it('does not attribute a finding when the working tree differs from the head ref', () => {
      writeFiles(root, { 'src/a.ts': 'export function A() {}\nexport function A2() {}\n' });
      commitAll(root, 'c1');
      writeFiles(root, { 'src/a.ts': 'export function Dirty() {}\n' });

      const r = buildStalenessReport(repo, root, { docIds: null, baseRef: c0, headRef: 'HEAD' });

      expect(r.documents[0]!.findings.map((f) => [f.path, f.attributable])).toEqual([['src/a.ts', false]]);
    });

    it('compares blobs in their working-tree form (eol conversion)', () => {
      writeFiles(root, { '.gitattributes': '*.cfg text eol=crlf\n', 'conf/x.cfg': 'a\r\nb\r\n' });
      const c1 = commitAll(root, 'c1');
      captureBaselines(repo, root);
      writeFiles(root, { 'conf/x.cfg': 'a\r\nc\r\n' });
      commitAll(root, 'c2');

      const r = buildStalenessReport(repo, root, { docIds: ['doc-c'], baseRef: c1, headRef: 'HEAD' });

      expect(r.documents.map((d) => [d.doc_id, d.all_attributable])).toEqual([['doc-c', true]]);
    });

    it('limits the report to the given doc_ids and rejects unknown ones', () => {
      writeFiles(root, { 'src/a.ts': 'export function X() {}\n', 'lib/b.ts': 'export function Y() {}\n' });
      const r = buildStalenessReport(repo, root, { docIds: ['doc-b'], baseRef: 'HEAD', headRef: null });
      expect(r.documents.map((d) => d.doc_id)).toEqual(['doc-b']);
      expect(() => buildStalenessReport(repo, root, { docIds: ['nope'], baseRef: 'HEAD', headRef: null })).toThrow(
        /not approved documents: nope/,
      );
    });

    it('rejects a ref that does not name a commit', () => {
      expect(() => buildStalenessReport(repo, root, { docIds: null, baseRef: 'no-such-ref', headRef: null })).toThrow(
        /no-such-ref/,
      );
    });

    it('carries source_path and ownership of each reported document', () => {
      writeFiles(root, { 'src/a.ts': 'export function X() {}\n' });
      const r = buildStalenessReport(repo, root, { docIds: null, baseRef: 'HEAD', headRef: null });
      expect(r.documents[0]).toMatchObject({ doc_id: 'doc-a', source_path: null, ownership: 'standalone' });
      expect(r.documents[0]!.findings[0]!.detail).toContain('src/a.ts');
    });
  });

  it('resolves blob paths relative to a project root below the git top level', async () => {
    const root = await setUp('app');
    writeFiles(root, { 'src/a.ts': 'export function Sub() {}\n' });
    commitAll(root, 'c1');

    const r = buildStalenessReport(repo, root, { docIds: null, baseRef: c0, headRef: 'HEAD' });

    expect(r.documents.map((d) => [d.doc_id, d.all_attributable])).toEqual([['doc-a', true]]);
  });
});
