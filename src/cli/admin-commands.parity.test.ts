import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabaseSnapshot } from '../core/store/database.js';
import { type AegisDatabase, createDatabase, Repository } from '../core/store/index.js';
import { createAegisServer } from '../mcp/server.js';
import { AegisService } from '../mcp/services.js';
import { type AdminCliExitCode, type AdminCliIo, type AdminCliSubcommand, runAdminCli } from './admin-commands.js';

const TEMPLATES_ROOT = join(import.meta.dirname, '../../templates');

const DUMP_TABLES = [
  'documents',
  'edges',
  'layer_rules',
  'observations',
  'proposals',
  'proposal_evidence',
  'snapshots',
  'snapshot_docs',
  'snapshot_edges',
  'snapshot_layer_rules',
  'knowledge_meta',
  'init_manifest',
  'tag_mappings',
  'staleness_baselines',
] as const;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

/** One side of a comparison: UUIDs become <uuid-N> in order of appearance, ISO timestamps become <ts>. */
function createNormalizer(): (value: unknown) => unknown {
  const uuids = new Map<string, number>();
  const replaceString = (s: string): string =>
    s
      .replace(UUID_RE, (m) => {
        const key = m.toLowerCase();
        let n = uuids.get(key);
        if (n === undefined) {
          n = uuids.size + 1;
          uuids.set(key, n);
        }
        return `<uuid-${n}>`;
      })
      .replace(TS_RE, '<ts>');
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return replaceString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return walk;
}

async function dumpDbState(dbPath: string): Promise<Record<string, unknown[]>> {
  const db = await openDatabaseSnapshot(dbPath);
  try {
    const dump: Record<string, unknown[]> = {};
    for (const table of DUMP_TABLES) {
      dump[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    }
    return dump;
  } finally {
    db.close();
  }
}

interface ParityFixture {
  root: string;
  projectRoot: string;
  mcpDbPath: string;
  cliDbPath: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function createParityFixture(options: {
  initialize: boolean;
  seed?: (repo: Repository, service: AegisService) => void | Promise<void>;
}): Promise<ParityFixture> {
  const root = mkdtempSync(join(tmpdir(), 'aegis-admin-parity-'));
  roots.push(root);
  const projectRoot = join(root, 'project');
  const dbDir = join(root, 'dbs');
  mkdirSync(projectRoot);
  mkdirSync(dbDir);
  writeFileSync(join(projectRoot, 'package.json'), '{"name":"parity-fixture"}\n');
  const fx: ParityFixture = {
    root,
    projectRoot,
    mcpDbPath: join(dbDir, 'mcp.db'),
    cliDbPath: join(dbDir, 'cli.db'),
  };
  if (!options.initialize) return fx;

  const fixtureDbPath = join(dbDir, 'fixture.db');
  const db = await createDatabase(fixtureDbPath);
  try {
    const repo = new Repository(db);
    const service = new AegisService(repo, TEMPLATES_ROOT, null, [], false, projectRoot);
    const preview = service.initDetect(projectRoot, 'admin', { skip_template: true });
    service.initConfirm(preview.preview_hash, 'admin');
    await options.seed?.(repo, service);
  } finally {
    db.close();
  }
  copyFileSync(fixtureDbPath, fx.mcpDbPath);
  copyFileSync(fixtureDbPath, fx.cliDbPath);
  return fx;
}

function parseToolText(name: string, text: string): unknown {
  return JSON.parse(name === 'aegis_init_confirm' ? (text.split('\n\nNext:')[0] ?? text) : text);
}

type McpArgs = Record<string, unknown> | ((previous: unknown[]) => Record<string, unknown>);

async function callMcpSequence(fx: ParityFixture, calls: Array<{ name: string; args: McpArgs }>): Promise<unknown[]> {
  const db: AegisDatabase = await createDatabase(fx.mcpDbPath);
  const service = new AegisService(new Repository(db), TEMPLATES_ROOT, null, [], false, fx.projectRoot);
  const server = createAegisServer(service, 'admin');
  const client = new Client({ name: 'parity-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const results: unknown[] = [];
    for (const call of calls) {
      const args = typeof call.args === 'function' ? call.args(results) : call.args;
      const res = await client.callTool({ name: call.name, arguments: args });
      const content = res.content as Array<{ type: string; text?: string }>;
      const text = content[0]?.text ?? '';
      if (res.isError) throw new Error(`MCP ${call.name} failed: ${text}`);
      results.push(parseToolText(call.name, text));
    }
    return results;
  } finally {
    await client.close();
    await server.close();
    db.close();
  }
}

async function callMcp(fx: ParityFixture, name: string, args: Record<string, unknown>): Promise<unknown> {
  const [result] = await callMcpSequence(fx, [{ name, args }]);
  return result;
}

function fakeIo(stdinText = ''): AdminCliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (t) => {
      out.push(t);
    },
    stderr: (l) => {
      err.push(l);
    },
    readStdin: async () => stdinText,
  };
}

async function callCli(
  fx: ParityFixture,
  sub: AdminCliSubcommand,
  input: unknown,
): Promise<{ code: AdminCliExitCode; json: unknown; err: string[] }> {
  const inputPath = join(fx.root, 'input.json');
  writeFileSync(inputPath, JSON.stringify(input));
  const io = fakeIo();
  const code = await runAdminCli(
    sub,
    ['--db', fx.cliDbPath, '--project-root', fx.projectRoot, '--templates', TEMPLATES_ROOT, '--input', inputPath],
    io,
    fx.root,
    TEMPLATES_ROOT,
  );
  const stdout = io.out.join('');
  return { code, json: stdout.trim() === '' ? null : JSON.parse(stdout), err: io.err };
}

async function expectParity(fx: ParityFixture, mcpResult: unknown, cliResult: unknown): Promise<void> {
  const normMcp = createNormalizer();
  const normCli = createNormalizer();
  expect(normCli(cliResult)).toEqual(normMcp(mcpResult));
  expect(normCli(await dumpDbState(fx.cliDbPath))).toEqual(normMcp(await dumpDbState(fx.mcpDbPath)));
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function insertNewDocProposal(repo: Repository, proposalId: string, docId: string, bundleId?: string): void {
  repo.insertProposal({
    proposal_id: proposalId,
    proposal_type: 'new_doc',
    payload: JSON.stringify({
      doc_id: docId,
      title: 'CLI New',
      kind: 'guideline',
      content: '# New\n',
      content_hash: sha256('# New\n'),
    }),
    status: 'pending',
    review_comment: null,
    ...(bundleId === undefined ? {} : { bundle_id: bundleId }),
  });
}

function insertAddEdgeProposal(repo: Repository, proposalId: string, targetDocId: string): void {
  repo.insertProposal({
    proposal_id: proposalId,
    proposal_type: 'add_edge',
    payload: JSON.stringify({
      edge_id: 'e-parity',
      source_type: 'path',
      source_value: 'src/**',
      target_doc_id: targetDocId,
      edge_type: 'path_requires',
      priority: 100,
      specificity: 0,
    }),
    status: 'pending',
    review_comment: null,
  });
}

const BATCH_ITEMS = [
  { content: '# A\n\nbody', source_label: 'a.md' },
  { content: '# B\n\nbody', source_label: 'b.md' },
];

describe('admin CLI parity with the admin MCP surface', () => {
  it('approve-proposal: approves a new_doc the same way', async () => {
    const fx = await createParityFixture({
      initialize: true,
      seed: (repo) => insertNewDocProposal(repo, 'p-new', 'cli-new'),
    });
    const input = { proposal_id: 'p-new' };
    const mcp = await callMcp(fx, 'aegis_approve_proposal', input);
    const cli = await callCli(fx, 'approve-proposal', input);
    expect(cli.err).toEqual([]);
    expect(cli.code).toBe(0);
    await expectParity(fx, mcp, cli.json);
  });

  it('approve-proposal: applies modifications to source_value the same way', async () => {
    const fx = await createParityFixture({
      initialize: true,
      seed: (repo, service) => {
        insertNewDocProposal(repo, 'p-new', 'cli-new');
        service.approveProposal('p-new', undefined, 'admin');
        insertAddEdgeProposal(repo, 'p-edge', 'cli-new');
      },
    });
    const input = { proposal_id: 'p-edge', modifications: { source_value: 'lib/**' } };
    const mcp = await callMcp(fx, 'aegis_approve_proposal', input);
    const cli = await callCli(fx, 'approve-proposal', input);
    expect(cli.err).toEqual([]);
    expect(cli.code).toBe(0);
    await expectParity(fx, mcp, cli.json);
    const dump = await dumpDbState(fx.cliDbPath);
    const edges = dump.edges as Array<{ source_value: string }>;
    expect(edges.some((e) => e.source_value === 'lib/**')).toBe(true);
  });

  it('import-doc: imports a document with edge_hints the same way', async () => {
    const fx = await createParityFixture({ initialize: true });
    const input = {
      doc_id: 'cli-doc',
      title: 'CLI Doc',
      kind: 'guideline',
      content: '# CLI\n',
      edge_hints: [{ source_type: 'path', source_value: 'src/**', edge_type: 'path_requires' }],
    };
    const mcp = await callMcp(fx, 'aegis_import_doc', input);
    const cli = await callCli(fx, 'import-doc', input);
    expect(cli.err).toEqual([]);
    expect(cli.code).toBe(0);
    await expectParity(fx, mcp, cli.json);
  });

  it('analyze-import-batch: analyzes a batch the same way', async () => {
    const fx = await createParityFixture({ initialize: true });
    const input = { items: BATCH_ITEMS };
    const mcp = await callMcp(fx, 'aegis_analyze_import_batch', input);
    const cli = await callCli(fx, 'analyze-import-batch', input);
    expect(cli.err).toEqual([]);
    expect(cli.code).toBe(0);
    await expectParity(fx, mcp, cli.json);
  });

  it('execute-import-plan: materializes a batch plan the same way', async () => {
    let batchPlan: unknown;
    const fx = await createParityFixture({
      initialize: true,
      seed: (_repo, service) => {
        batchPlan = service.analyzeImportBatch({ items: BATCH_ITEMS }, 'admin');
      },
    });
    const input = { batch_plan: batchPlan, bundle_id: 'bundle-parity' };
    const mcp = await callMcp(fx, 'aegis_execute_import_plan', input);
    const cli = await callCli(fx, 'execute-import-plan', input);
    expect(cli.err).toEqual([]);
    expect(cli.code).toBe(0);
    await expectParity(fx, mcp, cli.json);
  });

  it('init-confirm: initializes an empty database the same way', async () => {
    const fx = await createParityFixture({ initialize: false });
    (await createDatabase(fx.mcpDbPath)).close();
    const [detect, mcp] = await callMcpSequence(fx, [
      { name: 'aegis_init_detect', args: { project_root: fx.projectRoot, skip_template: true } },
      {
        name: 'aegis_init_confirm',
        args: (previous) => ({ preview_hash: (previous[0] as { preview_hash: string }).preview_hash }),
      },
    ]);
    const input = {
      preview_hash: (detect as { preview_hash: string }).preview_hash,
      project_root: fx.projectRoot,
      skip_template: true,
    };
    const cli = await callCli(fx, 'init-confirm', input);
    expect(cli.err).toEqual([]);
    expect(cli.code).toBe(0);
    await expectParity(fx, mcp, cli.json);
  });

  it('apply-upgrade: reports no proposals for a fixture without templates the same way', async () => {
    const fx = await createParityFixture({ initialize: true });
    const mcp = await callMcp(fx, 'aegis_apply_upgrade', {});
    const cli = await callCli(fx, 'apply-upgrade', {});
    expect(cli.err).toEqual([]);
    expect(cli.code).toBe(0);
    expect(cli.json).toEqual({ proposal_ids: [] });
    await expectParity(fx, mcp, cli.json);
  });

  it('reject-proposal: rejects a pending proposal the same way', async () => {
    const fx = await createParityFixture({
      initialize: true,
      seed: (repo) => insertNewDocProposal(repo, 'p-rej', 'rej-doc'),
    });
    const input = { proposal_id: 'p-rej', reason: 'not needed' };
    const mcp = await callMcp(fx, 'aegis_reject_proposal', input);
    const cli = await callCli(fx, 'reject-proposal', input);
    expect(cli.err).toEqual([]);
    expect(cli.code).toBe(0);
    await expectParity(fx, mcp, cli.json);
  });

  it('preflight-proposal-bundle: reports an ordering error with exit code 1 the same way', async () => {
    const fx = await createParityFixture({
      initialize: true,
      seed: (repo) => {
        repo.insertProposal({
          proposal_id: 'p-edge-bad',
          proposal_type: 'add_edge',
          payload: JSON.stringify({
            edge_id: 'e-bad',
            source_type: 'path',
            source_value: 'src/**',
            target_doc_id: 'nope',
            edge_type: 'path_requires',
            priority: 100,
            specificity: 0,
          }),
          status: 'pending',
          review_comment: null,
          bundle_id: 'bad-order',
        });
      },
    });
    const input = { bundle_id: 'bad-order' };
    const mcp = await callMcp(fx, 'aegis_preflight_proposal_bundle', input);
    const cli = await callCli(fx, 'preflight-proposal-bundle', input);
    expect(cli.code).toBe(1);
    expect(cli.err).toHaveLength(1);
    expect(cli.err[0]).toMatch(/^\[aegis\] preflight-proposal-bundle: ok=false bundle_id=bad-order/);
    await expectParity(fx, mcp, cli.json);
  });

  it('approve-proposal-bundle: approves a bundle the same way', async () => {
    const fx = await createParityFixture({
      initialize: true,
      seed: (repo) => insertNewDocProposal(repo, 'p-bundle', 'bundled-doc', 'ok-bundle'),
    });
    const input = { bundle_id: 'ok-bundle' };
    const mcp = await callMcp(fx, 'aegis_approve_proposal_bundle', input);
    const cli = await callCli(fx, 'approve-proposal-bundle', input);
    expect(cli.err).toEqual([]);
    expect(cli.code).toBe(0);
    await expectParity(fx, mcp, cli.json);
  });
});

describe('dist/main.js smoke', () => {
  const DIST_MAIN = join(import.meta.dirname, '../../dist/main.js');

  it.skipIf(!existsSync(DIST_MAIN))('routes approve-proposal and reads --input - from stdin', async () => {
    const fx = await createParityFixture({
      initialize: true,
      seed: (repo) => insertNewDocProposal(repo, 'p-new', 'cli-new'),
    });
    const res = spawnSync(
      process.execPath,
      [DIST_MAIN, 'approve-proposal', '--db', fx.cliDbPath, '--project-root', fx.projectRoot, '--input', '-'],
      { input: '{"proposal_id":"p-new"}', encoding: 'utf-8' },
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(JSON.parse(res.stdout)).toHaveProperty('knowledge_version');
  });
});
