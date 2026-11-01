import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryDatabase, Repository } from '../store/index.js';
import { ContextCompiler } from './compiler.js';
import { buildEdgesOutput, buildResolveOutput, type ResolvedPathResult } from './knowledge-query.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Helper: bootstrap a set of documents, edges, and layer_rules
 * through the standard Proposed → approve flow.
 */
function bootstrap(
  repo: Repository,
  data: {
    documents: {
      doc_id: string;
      title: string;
      kind: string;
      content: string;
      source_path?: string;
      ownership?: string;
    }[];
    edges: {
      edge_id: string;
      source_type: string;
      source_value: string;
      target_doc_id: string;
      edge_type: string;
      priority: number;
      specificity?: number;
    }[];
    layer_rules?: {
      rule_id: string;
      path_pattern: string;
      layer_name: string;
      priority: number;
      specificity?: number;
    }[];
  },
) {
  repo.insertProposal({
    proposal_id: 'boot',
    proposal_type: 'bootstrap',
    payload: JSON.stringify({
      documents: data.documents.map((d) => ({
        ...d,
        content_hash: hash(d.content),
      })),
      edges: data.edges.map((e) => ({
        ...e,
        specificity: e.specificity ?? 0,
      })),
      layer_rules: (data.layer_rules ?? []).map((r) => ({
        ...r,
        specificity: r.specificity ?? 0,
      })),
    }),
    status: 'pending',
    review_comment: null,
  });
  return repo.approveProposal('boot');
}

describe('buildEdgesOutput', () => {
  let repo: Repository;

  beforeEach(async () => {
    repo = new Repository(await createInMemoryDatabase());
    bootstrap(repo, {
      documents: [
        { doc_id: 'doc-a', title: 'A', kind: 'guideline', content: 'A', source_path: 'docs/a.md' },
        { doc_id: 'doc-b', title: 'B', kind: 'guideline', content: 'B' },
      ],
      edges: [
        {
          edge_id: 'e-1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'doc-a',
          edge_type: 'path_requires',
          priority: 100,
        },
        {
          edge_id: 'e-2',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'doc-b',
          edge_type: 'path_requires',
          priority: 100,
        },
        {
          edge_id: 'e-3',
          source_type: 'doc',
          source_value: 'doc-a',
          target_doc_id: 'doc-b',
          edge_type: 'doc_depends_on',
          priority: 100,
        },
      ],
    });

    repo.insertDocument({
      doc_id: 'doc-dep',
      title: 'Dep',
      kind: 'guideline',
      content: 'D',
      content_hash: hash('D'),
      status: 'deprecated',
      source_path: 'docs/dep.md',
    } as never);
    repo.insertEdge({
      edge_id: 'e-4',
      source_type: 'path',
      source_value: 'lib/**',
      target_doc_id: 'doc-dep',
      edge_type: 'path_requires',
      priority: 100,
      specificity: 0,
      status: 'approved',
    });

    for (const [edge_id, status] of [
      ['e-proposed', 'proposed'],
      ['e-deprecated', 'deprecated'],
    ] as const) {
      repo.insertEdge({
        edge_id,
        source_type: 'path',
        source_value: 'x/**',
        target_doc_id: 'doc-a',
        edge_type: 'path_requires',
        priority: 100,
        specificity: 0,
        status,
      });
    }

    repo.insertProposal({
      proposal_id: 'p-add',
      proposal_type: 'add_edge',
      payload: JSON.stringify({
        edge_id: 'e-pending',
        source_type: 'path',
        source_value: 'y/**',
        target_doc_id: 'doc-a',
        edge_type: 'path_requires',
        priority: 100,
        specificity: 0,
      }),
      status: 'pending',
      review_comment: null,
    });
  });

  it('lists only approved edges in edge_type, source_value, target_doc_id, edge_id order', () => {
    const ids = buildEdgesOutput(repo).edges.map((e) => e.edge_id);
    expect(ids).toEqual(['e-3', 'e-4', 'e-1', 'e-2']);
    expect(ids).not.toContain('e-proposed');
    expect(ids).not.toContain('e-deprecated');
    expect(ids).not.toContain('e-pending');
  });

  it('reports source_path as null when absent, and includes edges to deprecated documents', () => {
    const byId = new Map(buildEdgesOutput(repo).edges.map((e) => [e.edge_id, e]));
    expect(byId.get('e-2')?.source_path).toBeNull();
    expect(byId.get('e-1')?.source_path).toBe('docs/a.md');
    expect(byId.get('e-4')?.source_path).toBe('docs/dep.md');
  });

  it('emits fixed key order for the output and each edge', () => {
    const out = buildEdgesOutput(repo);
    expect(Object.keys(out)).toEqual(['schema_version', 'knowledge_version', 'edges']);
    expect(out.schema_version).toBe(1);
    expect(out.knowledge_version).toBe(repo.getKnowledgeMeta().current_version);
    expect(out.edges.length).toBeGreaterThan(0);
    for (const e of out.edges) {
      expect(Object.keys(e)).toEqual([
        'edge_id',
        'edge_type',
        'source_type',
        'source_value',
        'target_doc_id',
        'source_path',
        'priority',
        'specificity',
      ]);
    }
  });

  it('is byte-identical across calls', () => {
    expect(JSON.stringify(buildEdgesOutput(repo))).toBe(JSON.stringify(buildEdgesOutput(repo)));
  });

  it('returns an empty list for a database that was never bootstrapped', async () => {
    const empty = new Repository(await createInMemoryDatabase());
    expect(buildEdgesOutput(empty)).toEqual({
      schema_version: 1,
      knowledge_version: 0,
      edges: [],
    });
  });
});

describe('buildResolveOutput', () => {
  let repo: Repository;
  let compiler: ContextCompiler;

  // Contents stay <= 10 chars so compile() never exceeds the allocator budget.
  beforeEach(async () => {
    repo = new Repository(await createInMemoryDatabase());
    compiler = new ContextCompiler(repo);
    bootstrap(repo, {
      documents: [
        { doc_id: 'doc-a', title: 'A', kind: 'guideline', content: 'A', source_path: 'docs/a.md' },
        { doc_id: 'doc-b', title: 'B', kind: 'guideline', content: 'B' },
        { doc_id: 'doc-c', title: 'C', kind: 'guideline', content: 'C', source_path: 'docs/c.md' },
        { doc_id: 'tmpl', title: 'T', kind: 'template', content: 'T' },
        {
          doc_id: 'doc-layer',
          title: 'L',
          kind: 'guideline',
          content: 'L',
          source_path: 'docs/layer.md',
        },
      ],
      edges: [
        {
          edge_id: 'e-a',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'doc-a',
          edge_type: 'path_requires',
          priority: 100,
        },
        {
          edge_id: 'e-c',
          source_type: 'path',
          source_value: 'src/core/**',
          target_doc_id: 'doc-c',
          edge_type: 'path_requires',
          priority: 50,
          specificity: 1,
        },
        {
          edge_id: 'e-dep',
          source_type: 'doc',
          source_value: 'doc-a',
          target_doc_id: 'doc-b',
          edge_type: 'doc_depends_on',
          priority: 100,
        },
        {
          edge_id: 'e-tmpl',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'tmpl',
          edge_type: 'path_requires',
          priority: 100,
        },
        {
          edge_id: 'e-layer',
          source_type: 'layer',
          source_value: 'domain',
          target_doc_id: 'doc-layer',
          edge_type: 'layer_requires',
          priority: 100,
        },
      ],
      layer_rules: [{ rule_id: 'r-domain', path_pattern: 'lib/domain/**', layer_name: 'domain', priority: 100 }],
    });

    repo.insertDocument({
      doc_id: 'doc-dep',
      title: 'Dep',
      kind: 'guideline',
      content: 'D',
      content_hash: hash('D'),
      status: 'deprecated',
      source_path: 'docs/dep.md',
    } as never);
    repo.insertEdge({
      edge_id: 'e-depr',
      source_type: 'path',
      source_value: 'src/**',
      target_doc_id: 'doc-dep',
      edge_type: 'path_requires',
      priority: 100,
      specificity: 0,
      status: 'approved',
    });
  });

  async function expectSameAsCompile(compiler: ContextCompiler, result: ResolvedPathResult): Promise<void> {
    const compiled = await compiler.compile({ target_files: [result.normalized_path] });
    expect(result.documents.map((d) => d.doc_id)).toEqual(compiled.base.documents.map((d) => d.doc_id));
    // ResolvedDoc.source_path is string | undefined; resolve reports string | null.
    expect(result.documents.map((d) => d.source_path)).toEqual(
      compiled.base.documents.map((d) => d.source_path ?? null),
    );
    expect(result.resolution_path).toEqual(compiled.base.resolution_path);
  }

  function resolveOne(path: string): ResolvedPathResult {
    return buildResolveOutput(repo, compiler, [{ path, normalized_path: path }]).results[0];
  }

  it('matches compile for DAG expansion, excludes templates and deprecated documents', async () => {
    const result = resolveOne('src/main.ts');
    await expectSameAsCompile(compiler, result);
    const ids = result.documents.map((d) => d.doc_id);
    expect(ids).toContain('doc-a');
    expect(ids).toContain('doc-b');
    expect(ids).not.toContain('tmpl');
    expect(ids).not.toContain('doc-dep');
    const edgeIds = result.resolution_path.map((e) => e.edge_id);
    expect(edgeIds).toContain('e-tmpl');
    expect(edgeIds).toContain('e-depr');
  });

  it('orders more specific matches first', async () => {
    const result = resolveOne('src/core/x.ts');
    await expectSameAsCompile(compiler, result);
    expect(result.documents[0].doc_id).toBe('doc-c');
  });

  it('resolves documents through layer rules', async () => {
    const result = resolveOne('lib/domain/user.ts');
    await expectSameAsCompile(compiler, result);
    expect(result.documents.map((d) => d.doc_id)).toEqual(['doc-layer']);
  });

  it('returns empty documents and resolution_path when nothing matches', async () => {
    const result = resolveOne('no/such.txt');
    expect(result.documents).toEqual([]);
    expect(result.resolution_path).toEqual([]);
    await expectSameAsCompile(compiler, result);
  });

  it('attaches to each document only the edges that target it', () => {
    const result = resolveOne('src/main.ts');
    for (const doc of result.documents) {
      expect(doc.resolution_path).toEqual(result.resolution_path.filter((e) => e.target_doc_id === doc.doc_id));
    }
    const docB = result.documents.find((d) => d.doc_id === 'doc-b');
    expect(docB?.resolution_path).toEqual([
      {
        edge_id: 'e-dep',
        source_type: 'doc',
        source_value: 'doc-a',
        target_doc_id: 'doc-b',
        edge_type: 'doc_depends_on',
      },
    ]);
  });

  it('keeps input order and duplicates, and emits fixed key order', () => {
    const targets = [
      { path: './src/main.ts', normalized_path: 'src/main.ts' },
      { path: 'no/such.txt', normalized_path: 'no/such.txt' },
      { path: 'src/main.ts', normalized_path: 'src/main.ts' },
    ];
    const out = buildResolveOutput(repo, compiler, targets);
    expect(out.results.length).toBe(3);
    expect(out.results.map((r) => r.path)).toEqual(targets.map((t) => t.path));
    expect(out.results[0].documents).toEqual(out.results[2].documents);
    expect(Object.keys(out)).toEqual(['schema_version', 'knowledge_version', 'results']);
    expect(Object.keys(out.results[0])).toEqual(['path', 'normalized_path', 'documents', 'resolution_path']);
    expect(Object.keys(out.results[0].documents[0])).toEqual(['doc_id', 'source_path', 'resolution_path']);
  });

  it('returns empty results for a database that was never bootstrapped', async () => {
    const empty = new Repository(await createInMemoryDatabase());
    const out = buildResolveOutput(empty, new ContextCompiler(empty), [
      { path: 'src/main.ts', normalized_path: 'src/main.ts' },
      { path: 'lib/x.ts', normalized_path: 'lib/x.ts' },
    ]);
    expect(out.knowledge_version).toBe(0);
    expect(out.results.length).toBe(2);
    for (const r of out.results) {
      expect(r.documents).toEqual([]);
      expect(r.resolution_path).toEqual([]);
    }
  });
});
