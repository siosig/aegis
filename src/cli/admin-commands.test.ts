import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDetect } from '../core/init/engine.js';
import { createDatabase } from '../core/store/database.js';
import { Repository } from '../core/store/repository.js';
import { AegisService } from '../mcp/services.js';
import {
  ADMIN_CLI_SUBCOMMANDS,
  type AdminCliIo,
  isAdminCliSubcommand,
  parseAdminCliOptions,
  runAdminCli,
} from './admin-commands.js';

const TEMPLATES_ROOT = join(import.meta.dirname, '../../templates');

function createFakeIo(stdinText = ''): AdminCliIo & { out: string[]; err: string[] } {
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

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function createInitializedDb(root: string): Promise<{ projectRoot: string; dbPath: string }> {
  const projectRoot = join(root, 'proj');
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, 'package.json'), '{}');
  mkdirSync(join(root, 'db'));
  const dbPath = join(root, 'db', 'aegis.db');
  const db = await createDatabase(dbPath);
  try {
    const service = new AegisService(new Repository(db), TEMPLATES_ROOT, null, [], false, projectRoot);
    const preview = service.initDetect(projectRoot, 'admin', { skip_template: true });
    service.initConfirm(preview.preview_hash, 'admin');
  } finally {
    db.close();
  }
  return { projectRoot, dbPath };
}

async function withRepo<T>(dbPath: string, fn: (repo: Repository) => T): Promise<T> {
  const db = await createDatabase(dbPath);
  try {
    return fn(new Repository(db));
  } finally {
    db.close();
  }
}

function newDocPayload(docId: string): string {
  const content = `# ${docId}\n`;
  return JSON.stringify({ doc_id: docId, title: docId, kind: 'guideline', content, content_hash: sha256(content) });
}

function addEdgePayload(edgeId: string, targetDocId: string, sourceValue: string): string {
  return JSON.stringify({
    edge_id: edgeId,
    source_type: 'path',
    source_value: sourceValue,
    target_doc_id: targetDocId,
    edge_type: 'path_requires',
    priority: 100,
    specificity: 0,
  });
}

async function insertPending(dbPath: string, proposalId: string, type: 'new_doc' | 'add_edge', payload: string) {
  await withRepo(dbPath, (repo) => {
    repo.insertProposal({
      proposal_id: proposalId,
      proposal_type: type,
      payload,
      status: 'pending',
      review_comment: null,
      bundle_id: null,
    });
  });
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aegis-admin-cli-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(sub: Parameters<typeof runAdminCli>[0], args: string[], io: AdminCliIo) {
  return runAdminCli(sub, args, io, root, TEMPLATES_ROOT);
}

describe('admin CLI: options and input', () => {
  it('isAdminCliSubcommand matches exactly the 9 names', () => {
    const names = [
      'import-doc',
      'analyze-import-batch',
      'execute-import-plan',
      'init-confirm',
      'apply-upgrade',
      'reject-proposal',
      'preflight-proposal-bundle',
      'approve-proposal-bundle',
      'approve-proposal',
    ];
    expect([...ADMIN_CLI_SUBCOMMANDS]).toEqual(names);
    for (const name of names) expect(isAdminCliSubcommand(name)).toBe(true);
    for (const bad of ['Approve-Proposal', 'approve_proposal', 'edges', '', undefined]) {
      expect(isAdminCliSubcommand(bad)).toBe(false);
    }
  });

  it('parseAdminCliOptions applies defaults and resolves paths against cwd', () => {
    const base = parseAdminCliOptions([], root, TEMPLATES_ROOT);
    expect(base).toEqual({
      projectRoot: root,
      dbPath: join(root, '.aegis', 'aegis.db'),
      templatesRoot: TEMPLATES_ROOT,
      extraTemplateDirs: [],
      inputSource: null,
    });
    expect(parseAdminCliOptions(['--project-root', 'sub'], root, TEMPLATES_ROOT).dbPath).toBe(
      join(root, 'sub', '.aegis', 'aegis.db'),
    );
    expect(
      parseAdminCliOptions(['--template-dir', 'a', '--template-dir', 'b'], root, TEMPLATES_ROOT).extraTemplateDirs,
    ).toEqual([join(root, 'a'), join(root, 'b')]);
    expect(parseAdminCliOptions(['--input', '-'], root, TEMPLATES_ROOT).inputSource).toBe('-');
    expect(parseAdminCliOptions(['--input=x.json'], root, TEMPLATES_ROOT).inputSource).toBe(join(root, 'x.json'));
  });

  it.each([
    ['an unknown option', ['--surface', 'ssa'], undefined],
    ['--input without a value', ['--input'], undefined],
    ['a positional argument', ['extra'], undefined],
    ['an empty --db=', ['--db='], '--db requires a non-empty value'],
    ['an empty --template-dir=', ['--template-dir='], '--template-dir requires a non-empty value'],
  ])('rejects %s with exit 2 and a single prefixed stderr line', async (_label, args, message) => {
    const io = createFakeIo('{"proposal_id":"x"}');
    expect(await run('approve-proposal', args, io)).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toMatch(/^\[aegis\] approve-proposal: /);
    if (message) expect(io.err[0]).toContain(message);
  });

  it.each([
    ['broken JSON', '{', 'invalid input: not valid JSON ('],
    ['an array', '[]', 'invalid input: (root):'],
    ['a missing proposal_id', '{}', 'invalid input: proposal_id:'],
    ['a wrongly typed proposal_id', '{"proposal_id":1}', 'invalid input: proposal_id:'],
    ['an unknown top-level key', '{"proposal_id":"x","modification":{}}', 'modification'],
  ])('rejects %s with exit 2 without opening the DB', async (_label, stdin, expected) => {
    const dbPath = join(root, 'none.db');
    const io = createFakeIo(stdin);
    expect(await run('approve-proposal', ['--input', '-', '--db', dbPath], io)).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toContain(expected);
    expect(io.err[0]).not.toContain('Database not found');
    expect(existsSync(dbPath)).toBe(false);
  });

  it('rejects an unreadable --input file with the absolute path', async () => {
    const missing = join(root, 'nope.json');
    const dbPath = join(root, 'none.db');
    const io = createFakeIo();
    expect(await run('approve-proposal', ['--input', missing, '--db', dbPath], io)).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toContain(`cannot read --input ${missing}:`);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('reports a missing DB without creating its directory', async () => {
    const dbPath = join(root, 'missing', 'aegis.db');
    const io = createFakeIo('{"proposal_id":"x"}');
    expect(await run('approve-proposal', ['--input', '-', '--db', dbPath], io)).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toEqual([`[aegis] Database not found at ${dbPath}`]);
    expect(existsSync(join(root, 'missing'))).toBe(false);
  });
});

describe('admin CLI: approve-proposal', () => {
  async function approve(input: string, dbPath: string, projectRoot: string) {
    const io = createFakeIo(input);
    const code = await run('approve-proposal', ['--input', '-', '--db', dbPath, '--project-root', projectRoot], io);
    return { io, code };
  }

  it('approves a pending proposal and prints the version JSON', async () => {
    const { projectRoot, dbPath } = await createInitializedDb(root);
    await insertPending(dbPath, 'p-new', 'new_doc', newDocPayload('cli-new'));
    const { io, code } = await approve('{"proposal_id":"p-new"}', dbPath, projectRoot);
    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    const text = io.out.join('');
    expect(text.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(text);
    expect(typeof parsed.knowledge_version).toBe('number');
    expect(typeof parsed.snapshot_id).toBe('string');
    expect(await withRepo(dbPath, (repo) => repo.getProposal('p-new')?.status)).toBe('approved');
  });

  it('applies modifications to an add_edge proposal', async () => {
    const { projectRoot, dbPath } = await createInitializedDb(root);
    await insertPending(dbPath, 'p-new', 'new_doc', newDocPayload('cli-new'));
    expect((await approve('{"proposal_id":"p-new"}', dbPath, projectRoot)).code).toBe(0);
    await insertPending(dbPath, 'p-edge', 'add_edge', addEdgePayload('e-cli', 'cli-new', 'src/**'));
    const { io, code } = await approve(
      '{"proposal_id":"p-edge","modifications":{"source_value":"lib/**"}}',
      dbPath,
      projectRoot,
    );
    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    const edges = await withRepo(dbPath, (repo) => repo.getApprovedEdges());
    expect(edges.some((e) => e.source_value === 'lib/**' && e.target_doc_id === 'cli-new')).toBe(true);
  });

  it('fails for a nonexistent proposal without changing the version', async () => {
    const { projectRoot, dbPath } = await createInitializedDb(root);
    const before = await withRepo(dbPath, (repo) => repo.getKnowledgeMeta().current_version);
    const { io, code } = await approve('{"proposal_id":"missing"}', dbPath, projectRoot);
    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toEqual(['[aegis] approve-proposal: Proposal missing not found']);
    expect(await withRepo(dbPath, (repo) => repo.getKnowledgeMeta().current_version)).toBe(before);
  });

  it('fails for a proposal that is not pending', async () => {
    const { projectRoot, dbPath } = await createInitializedDb(root);
    await insertPending(dbPath, 'p-new', 'new_doc', newDocPayload('cli-new'));
    expect((await approve('{"proposal_id":"p-new"}', dbPath, projectRoot)).code).toBe(0);
    const before = await withRepo(dbPath, (repo) => repo.getKnowledgeMeta().current_version);
    const { io, code } = await approve('{"proposal_id":"p-new"}', dbPath, projectRoot);
    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err.join('\n')).toContain('is not pending');
    expect(await withRepo(dbPath, (repo) => repo.getKnowledgeMeta().current_version)).toBe(before);
  });

  it('rejects a disallowed modifications field and leaves the proposal pending', async () => {
    const { projectRoot, dbPath } = await createInitializedDb(root);
    await insertPending(dbPath, 'p-new', 'new_doc', newDocPayload('cli-new'));
    expect((await approve('{"proposal_id":"p-new"}', dbPath, projectRoot)).code).toBe(0);
    await insertPending(dbPath, 'p-edge', 'add_edge', addEdgePayload('e-cli', 'cli-new', 'src/**'));
    const { io, code } = await approve('{"proposal_id":"p-edge","modifications":{"title":"x"}}', dbPath, projectRoot);
    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err.join('\n')).toContain("Modification field 'title' is not allowed");
    expect(await withRepo(dbPath, (repo) => repo.getProposal('p-edge')?.status)).toBe('pending');
  });
});

describe('admin CLI: every subcommand reports failures with exit code 2', () => {
  const MIN_INPUTS: [Parameters<typeof runAdminCli>[0], string][] = [
    ['import-doc', JSON.stringify({ doc_id: 'd', title: 't', kind: 'guideline', content: 'c' })],
    ['analyze-import-batch', JSON.stringify({ items: [{ content: '# A' }] })],
    ['execute-import-plan', '{}'],
    ['apply-upgrade', '{}'],
    ['reject-proposal', JSON.stringify({ proposal_id: 'x', reason: 'r' })],
    ['preflight-proposal-bundle', JSON.stringify({ bundle_id: 'b' })],
    ['approve-proposal-bundle', JSON.stringify({ bundle_id: 'b' })],
  ];

  it.each(MIN_INPUTS)('%s: a missing DB gives exit 2 and "Database not found"', async (sub, input) => {
    const dbPath = join(root, 'missing.db');
    const io = createFakeIo(input);
    expect(await run(sub, ['--input', '-', '--db', dbPath], io)).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toContain('[aegis] Database not found at');
    expect(existsSync(dbPath)).toBe(false);
  });

  it.each([...MIN_INPUTS.map(([sub]) => sub), 'init-confirm' as const])(
    '%s: broken JSON gives exit 2 and an empty stdout',
    async (sub) => {
      const io = createFakeIo('{');
      expect(await run(sub, ['--input', '-', '--db', join(root, 'missing.db')], io)).toBe(2);
      expect(io.out).toEqual([]);
      expect(io.err).toHaveLength(1);
      expect(io.err[0]).toContain('invalid input: not valid JSON');
    },
  );

  async function runOn(sub: Parameters<typeof runAdminCli>[0], input: string, dbPath: string, projectRoot: string) {
    const io = createFakeIo(input);
    const code = await run(sub, ['--input', '-', '--db', dbPath, '--project-root', projectRoot], io);
    return { io, code };
  }

  it('apply-upgrade rejects an unknown top-level key', async () => {
    const io = createFakeIo('{"x":1}');
    expect(await run('apply-upgrade', ['--input', '-', '--db', join(root, 'none.db')], io)).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toContain('invalid input: (root):');
  });

  it('reject-proposal fails for a nonexistent proposal with one prefixed line', async () => {
    const { projectRoot, dbPath } = await createInitializedDb(root);
    const { io, code } = await runOn('reject-proposal', '{"proposal_id":"nope","reason":"r"}', dbPath, projectRoot);
    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toMatch(/^\[aegis\] reject-proposal: /);
  });

  it('approve-proposal-bundle fails when the bundle has no pending proposal', async () => {
    const { projectRoot, dbPath } = await createInitializedDb(root);
    const { io, code } = await runOn('approve-proposal-bundle', '{"bundle_id":"no-such"}', dbPath, projectRoot);
    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toMatch(/^\[aegis\] approve-proposal-bundle: /);
  });

  it('preflight-proposal-bundle succeeds for a valid bundle', async () => {
    const { projectRoot, dbPath } = await createInitializedDb(root);
    await withRepo(dbPath, (repo) => {
      repo.insertProposal({
        proposal_id: 'p-ok',
        proposal_type: 'new_doc',
        payload: newDocPayload('ok-doc'),
        status: 'pending',
        review_comment: null,
        bundle_id: 'ok-bundle',
      });
    });
    const { io, code } = await runOn('preflight-proposal-bundle', '{"bundle_id":"ok-bundle"}', dbPath, projectRoot);
    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    expect(JSON.parse(io.out.join('')).ok).toBe(true);
  });

  it('import-doc creates proposals and prints proposal_ids and warnings', async () => {
    const { projectRoot, dbPath } = await createInitializedDb(root);
    const input = JSON.stringify({ doc_id: 'd', title: 't', kind: 'guideline', content: 'c' });
    const { io, code } = await runOn('import-doc', input, dbPath, projectRoot);
    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    const parsed = JSON.parse(io.out.join(''));
    expect(parsed.proposal_ids.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });
});

describe('admin CLI: init-confirm', () => {
  let projectRoot: string;
  let dbPath: string;
  let previewHash: string;

  beforeEach(() => {
    projectRoot = join(root, 'proj');
    mkdirSync(projectRoot);
    writeFileSync(join(projectRoot, 'package.json'), '{}');
    dbPath = join(projectRoot, '.aegis', 'aegis.db');
    previewHash = initDetect(projectRoot, TEMPLATES_ROOT, [], { skip_template: true }).preview_hash;
  });

  async function confirm(input: unknown, args: string[]) {
    const io = createFakeIo(JSON.stringify(input));
    const code = await run('init-confirm', ['--input', '-', ...args], io);
    return { io, code };
  }

  it('creates the DB, the directory and .gitignore when the DB does not exist', async () => {
    const { io, code } = await confirm({ preview_hash: previewHash, skip_template: true }, [
      '--project-root',
      projectRoot,
    ]);
    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    expect(existsSync(dbPath)).toBe(true);
    expect(readFileSync(join(projectRoot, '.aegis', '.gitignore'), 'utf-8')).toBe('*\n');
    const parsed = JSON.parse(io.out.join(''));
    expect(typeof parsed.knowledge_version).toBe('number');
    expect(typeof parsed.snapshot_id).toBe('string');
    expect(await withRepo(dbPath, (repo) => repo.isInitialized())).toBe(true);
  });

  it('creates nothing when the preview_hash does not match', async () => {
    const { io, code } = await confirm({ preview_hash: 'wrong', skip_template: true }, ['--project-root', projectRoot]);
    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toHaveLength(1);
    expect(
      io.err[0].startsWith('[aegis] init-confirm: preview_hash mismatch: expected wrong but init_detect produced '),
    ).toBe(true);
    expect(existsSync(join(projectRoot, '.aegis'))).toBe(false);
  });

  it('takes project_root from the input and resolves it against cwd', async () => {
    const otherDb = join(root, 'elsewhere', 'aegis.db');
    const { io, code } = await confirm({ preview_hash: previewHash, project_root: projectRoot, skip_template: true }, [
      '--db',
      otherDb,
    ]);
    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    expect(existsSync(otherDb)).toBe(true);
  });

  it('fails with exit 2 when the DB is already initialized', async () => {
    const input = { preview_hash: previewHash, skip_template: true };
    expect((await confirm(input, ['--project-root', projectRoot])).code).toBe(0);
    const { io, code } = await confirm(input, ['--project-root', projectRoot]);
    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toMatch(/^\[aegis\] init-confirm: /);
  });

  it.each([
    ['a missing preview_hash', {}, 'invalid input: preview_hash:'],
    ['an empty project_root', { preview_hash: 'h', project_root: '' }, 'invalid input: project_root:'],
    ['an unknown key', { preview_hash: 'h', extra: 1 }, 'invalid input: (root):'],
  ])('rejects %s with exit 2 and creates nothing', async (_label, input, expected) => {
    const { io, code } = await confirm(input, ['--project-root', projectRoot]);
    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toContain(expected);
    expect(existsSync(join(projectRoot, '.aegis'))).toBe(false);
  });
});
