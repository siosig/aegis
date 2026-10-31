import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Document, Edge } from '../types.js';
import {
  buildEdgeMatchers,
  collectSemanticStalenessFindings,
  extractTsExportedSymbols,
  FingerprintMemo,
  findRenameCandidatePath,
  fingerprintEdgeLinkedArtifacts,
  linkedPathsForDoc,
  linkedPathsForMultiSourceStaleness,
  linkedPathsFromSourceRefs,
  listRepoRelativeFiles,
  SEMANTIC_STALENESS_ALGORITHM_VERSION,
  stableStringifyFingerprints,
} from './staleness.js';

function hashUtf8(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('optimization/staleness (ADR-015 Task 015-07)', () => {
  it('extractTsExportedSymbols collects deterministic exported-like names', () => {
    const src = `
export function Alpha() {}
export class Beta {}
export const Gamma = 1;
export interface Delta {}
`;
    expect(extractTsExportedSymbols(src)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
  });

  it('extractTsExportedSymbols parses export { ... } lists', () => {
    expect(extractTsExportedSymbols(`export { One, Two as T2 } from './mod';\n`)).toEqual(['One', 'Two']);
  });

  it('extractTsExportedSymbols ignores non-exported top-level declarations', () => {
    expect(extractTsExportedSymbols(`function Internal() {}\nexport function Pub() {}\n`)).toEqual(['Pub']);
  });

  it('Level 1 reports hash mismatch for file-anchored doc', () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-stale-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs/x.md'), 'on disk', 'utf-8');

    const doc: Document = {
      doc_id: 'd1',
      title: 'T',
      kind: 'guideline',
      content: 'canonical body',
      content_hash: hashUtf8('canonical body'),
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: 'docs/x.md',
      source_refs_json: null,
      source_synced_at: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };

    const r = collectSemanticStalenessFindings({
      docs: [doc],
      edges: [],
      projectRoot: root,
      getBaseline: () => null,
      persistLevel3Baselines: false,
    });

    expect(r.findings.some((f) => f.level === 1 && f.kind === 'hash_mismatch')).toBe(true);
    expect(r.findings[0]?.algorithm_version).toBe(SEMANTIC_STALENESS_ALGORITHM_VERSION);
  });

  it('Level 2 reports missing source_path and rename candidate when hash matches elsewhere', () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-stale-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    const body = 'same bytes';
    const h = hashUtf8(body);
    writeFileSync(join(root, 'docs/new.md'), body, 'utf-8');

    const doc: Document = {
      doc_id: 'd-miss',
      title: 'T',
      kind: 'guideline',
      content: body,
      content_hash: h,
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: 'docs/old.md',
      source_refs_json: null,
      source_synced_at: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };

    const files = listRepoRelativeFiles(root);
    expect(findRenameCandidatePath(root, files, h)).toBe('docs/new.md');

    const r = collectSemanticStalenessFindings({
      docs: [doc],
      edges: [],
      projectRoot: root,
      getBaseline: () => null,
      persistLevel3Baselines: false,
    });

    expect(r.findings.some((f) => f.kind === 'source_missing')).toBe(true);
    expect(r.findings.some((f) => f.kind === 'rename_candidate' && f.rename_candidate_path === 'docs/new.md')).toBe(
      true,
    );
  });

  it('Level 3 detects symbol drift vs baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-stale-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/mod.ts'), `export function Keep() {}\nexport function Gone() {}\n`, 'utf-8');

    const doc: Document = {
      doc_id: 'guide',
      title: 'G',
      kind: 'guideline',
      content: 'x',
      content_hash: hashUtf8('x'),
      status: 'approved',
      ownership: 'standalone',
      template_origin: null,
      source_path: null,
      source_refs_json: null,
      source_synced_at: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };

    const edges: Edge[] = [
      {
        edge_id: 'e1',
        source_type: 'path',
        source_value: 'src/**/*.ts',
        target_doc_id: 'guide',
        edge_type: 'path_requires',
        priority: 10,
        specificity: 10,
        status: 'approved',
        created_at: '2020-01-01T00:00:00.000Z',
      },
    ];

    const relFiles = listRepoRelativeFiles(root);
    expect(linkedPathsForDoc('guide', edges, relFiles)).toEqual(['src/mod.ts']);

    const prevSyms = extractTsExportedSymbols(`export function Keep() {}\nexport function Gone() {}\n`);
    const prevJson = stableStringifyFingerprints({
      'src/mod.ts': `sym:${hashUtf8(prevSyms.join('\n'))}`,
    });

    writeFileSync(join(root, 'src/mod.ts'), `export function Keep() {}\n`, 'utf-8');

    const r = collectSemanticStalenessFindings({
      docs: [doc],
      edges,
      projectRoot: root,
      getBaseline: (id) => (id === 'guide' ? prevJson : null),
      persistLevel3Baselines: false,
    });

    expect(r.findings.some((f) => f.level === 3 && f.kind === 'symbol_drift')).toBe(true);
  });

  it('Level 3 establishes baseline when none exists (no drift findings)', () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-stale-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), 'export const X = 1;\n', 'utf-8');

    const doc: Document = {
      doc_id: 'g2',
      title: 'G',
      kind: 'guideline',
      content: 'x',
      content_hash: hashUtf8('x'),
      status: 'approved',
      ownership: 'standalone',
      template_origin: null,
      source_path: null,
      source_refs_json: null,
      source_synced_at: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };

    const edges: Edge[] = [
      {
        edge_id: 'e1',
        source_type: 'path',
        source_value: 'src/*.ts',
        target_doc_id: 'g2',
        edge_type: 'path_requires',
        priority: 10,
        specificity: 10,
        status: 'approved',
        created_at: '2020-01-01T00:00:00.000Z',
      },
    ];

    const r = collectSemanticStalenessFindings({
      docs: [doc],
      edges,
      projectRoot: root,
      getBaseline: () => null,
      persistLevel3Baselines: true,
    });

    expect(r.findings).toHaveLength(0);
    expect(r.baselineUpserts.some((b) => b.doc_id === 'g2')).toBe(true);
  });

  it('multi-source doc fingerprints source_refs_json assets without path_requires edges (015-10)', () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-ms-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    const a1 = 'alpha v1\n';
    const b0 = 'beta\n';
    writeFileSync(join(root, 'docs/a.md'), a1, 'utf-8');
    writeFileSync(join(root, 'docs/b.md'), b0, 'utf-8');

    const doc: Document = {
      doc_id: 'ms1',
      title: 'M',
      kind: 'guideline',
      content: 'merged body',
      content_hash: hashUtf8('merged body'),
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: 'docs/ghost.md',
      source_refs_json: JSON.stringify([
        { asset_path: 'docs/a.md', anchor_type: 'file', anchor_value: '' },
        { asset_path: 'docs/b.md', anchor_type: 'file', anchor_value: '' },
      ]),
      source_synced_at: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };

    expect(linkedPathsFromSourceRefs(doc)).toEqual(['docs/a.md', 'docs/b.md']);

    const baselineJson = stableStringifyFingerprints({
      'docs/a.md': `raw:${hashUtf8(a1)}`,
      'docs/b.md': `raw:${hashUtf8(b0)}`,
    });

    writeFileSync(join(root, 'docs/a.md'), 'alpha v2\n', 'utf-8');

    const r = collectSemanticStalenessFindings({
      docs: [doc],
      edges: [],
      projectRoot: root,
      getBaseline: () => baselineJson,
      persistLevel3Baselines: false,
    });

    expect(r.findings.some((f) => f.level === 3 && f.paths?.includes('docs/a.md'))).toBe(true);
  });

  it('multi-source Level-3 fingerprints include legacy source_path alongside source_refs (015-10)', () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-ms-ps-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    const p0 = 'p0\n';
    const s0 = 's0\n';
    writeFileSync(join(root, 'docs/primary.md'), p0, 'utf-8');
    writeFileSync(join(root, 'docs/secondary.md'), s0, 'utf-8');

    const doc: Document = {
      doc_id: 'ms-ps',
      title: 'M',
      kind: 'guideline',
      content: 'merged',
      content_hash: hashUtf8('merged'),
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: 'docs/primary.md',
      source_refs_json: JSON.stringify([{ asset_path: 'docs/secondary.md', anchor_type: 'file', anchor_value: '' }]),
      source_synced_at: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };

    expect(linkedPathsFromSourceRefs(doc)).toEqual(['docs/secondary.md']);
    expect(linkedPathsForMultiSourceStaleness(doc)).toEqual(['docs/primary.md', 'docs/secondary.md']);

    const baselineJson = stableStringifyFingerprints({
      'docs/primary.md': `raw:${hashUtf8(p0)}`,
      'docs/secondary.md': `raw:${hashUtf8(s0)}`,
    });

    writeFileSync(join(root, 'docs/primary.md'), 'p1\n', 'utf-8');

    const r = collectSemanticStalenessFindings({
      docs: [doc],
      edges: [],
      projectRoot: root,
      getBaseline: () => baselineJson,
      persistLevel3Baselines: false,
    });

    expect(r.findings.some((f) => f.level === 3 && f.paths?.includes('docs/primary.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 001-aegis-perf-upgrade US1 (T009): memoized fingerprints, git-visible listing, baseline migration
// ---------------------------------------------------------------------------

function approvedDoc(docId: string): Document {
  return {
    doc_id: docId,
    title: docId,
    kind: 'guideline',
    content: `body ${docId}`,
    content_hash: hashUtf8(`body ${docId}`),
    status: 'approved',
    ownership: 'standalone',
    template_origin: null,
    source_path: null,
    source_refs_json: null,
    source_synced_at: null,
    created_at: '2020-01-01T00:00:00.000Z',
    updated_at: '2020-01-01T00:00:00.000Z',
  };
}

function pathEdge(edgeId: string, glob: string, targetDocId: string, overrides: Partial<Edge> = {}): Edge {
  return {
    edge_id: edgeId,
    source_type: 'path',
    source_value: glob,
    target_doc_id: targetDocId,
    edge_type: 'path_requires',
    priority: 10,
    specificity: 10,
    status: 'approved',
    created_at: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  }
}

/** Temp dir that is a git work tree (files staged, no commit needed for `git ls-files`). */
function makeGitFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'aegis-stale-git-'));
  writeFiles(root, files);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  return root;
}

/** Temp dir outside any git work tree (listing falls back to the directory walk). */
function makeWalkFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'aegis-stale-walk-'));
  writeFiles(root, files);
  return root;
}

describe('optimization/staleness (001-aegis-perf-upgrade US1)', () => {
  it('FingerprintMemo computes once per key and remembers null', () => {
    const memo = new FingerprintMemo();
    let calls = 0;
    const compute = (): string | null => {
      calls += 1;
      return 'fp-a';
    };
    expect(memo.get('src/a.ts', compute)).toBe('fp-a');
    expect(memo.get('src/a.ts', compute)).toBe('fp-a');
    expect(memo.get('src/a.ts', compute)).toBe('fp-a');
    expect(calls).toBe(1);
    expect(memo.computeCount).toBe(1);

    let nullCalls = 0;
    const computeNull = (): string | null => {
      nullCalls += 1;
      return null;
    };
    expect(memo.get('src/missing.ts', computeNull)).toBeNull();
    expect(memo.get('src/missing.ts', computeNull)).toBeNull();
    expect(nullCalls).toBe(1);

    expect(memo.get('src/b.ts', () => 'fp-b')).toBe('fp-b');
    expect(memo.computeCount).toBe(3);
  });

  it('fingerprintEdgeLinkedArtifacts with a memo reads each path once across calls', () => {
    const root = makeWalkFixture({ 'src/a.ts': 'export const A = 1;\n' });
    const memo = new FingerprintMemo();
    const first = fingerprintEdgeLinkedArtifacts(root, ['src/a.ts'], memo);
    const second = fingerprintEdgeLinkedArtifacts(root, ['src/a.ts'], memo);
    expect(second).toEqual(first);
    expect(memo.computeCount).toBe(1);
    expect(fingerprintEdgeLinkedArtifacts(root, ['src/a.ts'])).toEqual(first);
  });

  it('buildEdgeMatchers keeps only approved path_requires path edges targeting the doc (dot: true)', () => {
    const edges: Edge[] = [
      pathEdge('e1', '**/*.yml', 'g1'),
      pathEdge('e2', 'docs/**', 'g1', { status: 'proposed' }),
      pathEdge('e3', 'lib/**', 'g1', { edge_type: 'layer_requires' }),
      pathEdge('e4', 'cmd/**', 'g1', { source_type: 'command' }),
      pathEdge('e5', 'other/**', 'g2'),
    ];
    const matchers = buildEdgeMatchers('g1', edges);
    expect(matchers).toHaveLength(1);
    const matches = (p: string): boolean => matchers.some((m) => m(p));
    expect(matches('.github/x.yml')).toBe(true);
    expect(matches('docs/a.md')).toBe(false);
    expect(matches('lib/a.ts')).toBe(false);
    expect(matches('cmd/a.ts')).toBe(false);
    expect(matches('other/a.ts')).toBe(false);
    expect(buildEdgeMatchers('nobody', edges)).toEqual([]);
  });

  it('linkedPathsForDoc returns the same sorted, deduplicated paths as before', () => {
    const edges: Edge[] = [
      pathEdge('e1', '**/*.yml', 'g1'),
      pathEdge('e2', 'src/*.ts', 'g1'),
      pathEdge('e3', 'src/a.ts', 'g1'),
      pathEdge('e4', 'README.md', 'g1', { status: 'proposed' }),
    ];
    const files = ['.github/x.yml', 'README.md', 'src/a.ts', 'src/b.ts', 'src/sub/c.ts'];
    expect(linkedPathsForDoc('g1', edges, files)).toEqual(['.github/x.yml', 'src/a.ts', 'src/b.ts']);
    expect(linkedPathsForDoc('g2', edges, files)).toEqual([]);
  });

  it('SEMANTIC_STALENESS_ALGORITHM_VERSION is 015-10-3', () => {
    expect(SEMANTIC_STALENESS_ALGORITHM_VERSION).toBe('015-10-3');
  });

  it('computes one fingerprint per distinct path when two docs link the same file', () => {
    const root = makeWalkFixture({ 'src/a.ts': 'export const A = 1;\n' });
    const r = collectSemanticStalenessFindings({
      docs: [approvedDoc('d1'), approvedDoc('d2')],
      edges: [pathEdge('e1', 'src/a.ts', 'd1'), pathEdge('e2', 'src/a.ts', 'd2')],
      projectRoot: root,
      getBaseline: () => null,
      persistLevel3Baselines: true,
    });
    expect(r.baselineUpserts.map((b) => b.doc_id).sort()).toEqual(['d1', 'd2']);
    expect(r.stats.fingerprints_computed).toBe(1);
  });

  it('findings in a git work tree equal findings of the directory walk over the same files', () => {
    const files: Record<string, string> = {
      'src/a.ts': 'export const A = 1;\n',
      'src/b.ts': 'export const B = 2;\n',
      'docs/x.md': '# x\n',
    };
    const gitRoot = makeGitFixture(files);
    const walkRoot = makeWalkFixture(files);
    const staleBaseline = stableStringifyFingerprints({
      'src/a.ts': 'raw:stale',
      'src/gone.ts': 'raw:gone',
    });
    const run = (projectRoot: string) =>
      collectSemanticStalenessFindings({
        docs: [approvedDoc('d1')],
        edges: [pathEdge('e1', 'src/**', 'd1')],
        projectRoot,
        getBaseline: () => staleBaseline,
        persistLevel3Baselines: true,
      });

    const viaGit = run(gitRoot);
    const viaWalk = run(walkRoot);
    expect(viaGit.stats.listing_source).toBe('git');
    expect(viaWalk.stats.listing_source).toBe('walk');
    expect(viaGit.findings.length).toBeGreaterThan(0);
    expect(viaGit.findings).toEqual(viaWalk.findings);
  });

  describe('baseline migration for paths that left the listing', () => {
    const keepBody = 'export const keep = 1;\n';

    function setup(opts: { ignoredGlob: string }): {
      root: string;
      run: () => ReturnType<typeof collectSemanticStalenessFindings>;
    } {
      const root = makeGitFixture({
        '.gitignore': 'ignored/\n',
        'src/keep.ts': keepBody,
        'ignored/x.ts': 'export const ignored = 1;\n',
      });
      const keepFp = fingerprintEdgeLinkedArtifacts(root, ['src/keep.ts']);
      const baselineJson = stableStringifyFingerprints({ ...keepFp, 'ignored/x.ts': 'raw:ignored-before' });
      const run = () =>
        collectSemanticStalenessFindings({
          docs: [approvedDoc('d1')],
          edges: [pathEdge('e1', opts.ignoredGlob, 'd1'), pathEdge('e2', 'src/keep.ts', 'd1')],
          projectRoot: root,
          getBaseline: () => baselineJson,
          persistLevel3Baselines: true,
        });
      return { root, run };
    }

    it('(a) file still exists but left the listing: no finding, baseline rewritten once', () => {
      const { run } = setup({ ignoredGlob: 'ignored/**' });
      const r = run();
      expect(r.findings).toHaveLength(0);
      expect(r.baselineUpserts).toHaveLength(1);
      expect(r.baselineUpserts[0]?.doc_id).toBe('d1');
      expect(Object.keys(JSON.parse(r.baselineUpserts[0]!.fingerprint_json) as Record<string, string>)).toEqual([
        'src/keep.ts',
      ]);
    });

    it('(b) git-ignored file deleted: no finding, baseline rewritten once', () => {
      const { root, run } = setup({ ignoredGlob: 'ignored/**' });
      rmSync(join(root, 'ignored/x.ts'));
      const r = run();
      expect(r.findings).toHaveLength(0);
      expect(r.baselineUpserts).toHaveLength(1);
      expect(Object.keys(JSON.parse(r.baselineUpserts[0]!.fingerprint_json) as Record<string, string>)).toEqual([
        'src/keep.ts',
      ]);
    });

    it('(c) git-ignored file whose edge glob no longer matches: no finding', () => {
      const { run } = setup({ ignoredGlob: 'other/**' });
      expect(run().findings).toHaveLength(0);
    });

    it('(d) path in a skipped directory deleted: no finding', () => {
      const root = makeGitFixture({ 'src/keep.ts': keepBody });
      const keepFp = fingerprintEdgeLinkedArtifacts(root, ['src/keep.ts']);
      const baselineJson = stableStringifyFingerprints({ ...keepFp, 'node_modules/pkg/index.js': 'raw:gone' });
      const r = collectSemanticStalenessFindings({
        docs: [approvedDoc('d1')],
        edges: [pathEdge('e1', '**', 'd1')],
        projectRoot: root,
        getBaseline: () => baselineJson,
        persistLevel3Baselines: true,
      });
      expect(r.findings).toHaveLength(0);
      expect(r.baselineUpserts).toHaveLength(1);
    });

    it('(e) visible (not ignored) file deleted: linked_file_removed is reported', () => {
      const root = makeGitFixture({ '.gitignore': 'ignored/\n', 'src/keep.ts': keepBody, 'src/gone.ts': 'x\n' });
      const fp = fingerprintEdgeLinkedArtifacts(root, ['src/gone.ts', 'src/keep.ts']);
      rmSync(join(root, 'src/gone.ts'));
      const r = collectSemanticStalenessFindings({
        docs: [approvedDoc('d1')],
        edges: [pathEdge('e1', 'src/**', 'd1')],
        projectRoot: root,
        getBaseline: () => stableStringifyFingerprints(fp),
        persistLevel3Baselines: true,
      });
      const removed = r.findings.filter((f) => f.kind === 'linked_file_removed');
      expect(removed.map((f) => f.paths)).toEqual([['src/gone.ts']]);
      expect(r.baselineUpserts).toHaveLength(0);
    });
  });

  it('stats report listing_source and files_listed', () => {
    const files: Record<string, string> = {
      '.gitignore': 'ignored/\n',
      'src/a.ts': 'export const A = 1;\n',
      'ignored/z.ts': 'export const Z = 1;\n',
    };
    const input = (projectRoot: string) => ({
      docs: [approvedDoc('d1')],
      edges: [pathEdge('e1', 'src/**', 'd1')],
      projectRoot,
      getBaseline: () => null,
      persistLevel3Baselines: false,
    });
    const viaGit = collectSemanticStalenessFindings(input(makeGitFixture(files)));
    expect(viaGit.stats.listing_source).toBe('git');
    expect(viaGit.stats.files_listed).toBe(2); // .gitignore, src/a.ts (ignored/z.ts excluded)

    const viaWalk = collectSemanticStalenessFindings(input(makeWalkFixture(files)));
    expect(viaWalk.stats.listing_source).toBe('walk');
    expect(viaWalk.stats.files_listed).toBe(3);
  });
});
