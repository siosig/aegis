/**
 * Smoke tests for `npx aegis stats` / `npx aegis doctor` (built dist/main.js).
 * `pnpm test` runs `build` first (see package.json), so dist exists.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from './core/store/database.js';
import { Repository } from './core/store/repository.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Bootstrap documents and edges through the standard Proposed → approve flow
 * (same shape as src/core/read/compiler.test.ts).
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
      layer_rules: [],
    }),
    status: 'pending',
    review_comment: null,
  });
  return repo.approveProposal('boot');
}

const MAIN_JS = join(dirname(fileURLToPath(import.meta.url)), '../dist/main.js');

describe('CLI — stats / doctor (dist/main.js)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const dbPath = join(dir, '.aegis', 'aegis.db');
    const db = await createDatabase(dbPath);
    // Release file + advisory lock before spawning CLI (Linux CI: second open must not contend).
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stats prints JSON with knowledge and health and project_share', () => {
    const r = spawnSync(execPath, [MAIN_JS, 'stats', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const stderr = r.stderr ?? '';
    expect(stderr).not.toMatch(/Database not found/i);
    const body = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(body.knowledge).toBeDefined();
    expect(body.usage).toBeDefined();
    expect(body.health).toBeDefined();
    expect(body.project_share).toBeDefined();
    const ps = body.project_share as { state: string };
    expect(ps.state).toBe('not_configured');
  }, 15_000);

  it('doctor exits 0 when no health issues', () => {
    const r = spawnSync(execPath, [MAIN_JS, 'doctor', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('Status: OK');
  });
});

describe('CLI — doctor exit 1 on health issues', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-bad-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const dbPath = join(dir, '.aegis', 'aegis.db');
    const db = await createDatabase(dbPath);
    const repo = new Repository(db);
    repo.insertObservation({
      observation_id: 'obs-cli-doctor',
      event_type: 'compile_miss',
      payload: JSON.stringify({ target_files: ['a.ts'], review_comment: 'x' }),
      related_compile_id: 'c1',
      related_snapshot_id: 's1',
    });
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('doctor exits 1 when unanalyzed observations exist', () => {
    const r = spawnSync(execPath, [MAIN_JS, 'doctor', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stdout).toContain('Status: attention');
    expect(r.stdout).toContain('unanalyzed observation');
  });
});

describe('CLI — doctor project-share surfacing', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('doctor exits 1 when bundle is newer than local', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-doctor-share-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const dbPath = join(dir, '.aegis', 'aegis.db');
    const db = await createDatabase(dbPath);
    db.close();

    // Write a manifest with knowledge_version > 0 (local is 0 / uninitialized)
    const shareDir = join(dir, 'aegis-share');
    mkdirSync(shareDir, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(shareDir, 'manifest.json'),
      JSON.stringify({
        format_version: 1,
        bundle_file: 'canonical.json',
        snapshot_id: 'snap-remote',
        knowledge_version: 5,
        bundle_sha256: 'abc',
        includes_tag_mappings: false,
      }),
    );
    writeFileSync(join(shareDir, 'canonical.json'), '{}');

    const r = spawnSync(execPath, [MAIN_JS, 'doctor', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stdout).toContain('project_share: bundle_newer');
    expect(r.stdout).toContain('project-share bundle_newer');
  }, 15_000);
});

describe('CLI — share-export (dist/main.js)', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when DB is not initialized', () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-share-uninit-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    // Create empty DB (not initialized)
    const db = createDatabase(join(dir, '.aegis', 'aegis.db'));
    // createDatabase is async but we need to wait
    return db.then((d) => {
      d.close();
      const r = spawnSync(execPath, [MAIN_JS, 'share-export', '--project-root', dir], {
        encoding: 'utf-8',
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(1);
      expect(r.stderr).toContain('not initialized');
    });
  });

  it('exports to default aegis-share/ directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-share-ok-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const dbPath = join(dir, '.aegis', 'aegis.db');
    const d = await createDatabase(dbPath);
    const repo = new Repository(d);
    repo.insertProposal({
      proposal_id: 'boot',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [{ doc_id: 'doc-1', title: 'D1', kind: 'guideline', content: 'c', content_hash: hash('c') }],
        edges: [
          {
            edge_id: 'e1',
            source_type: 'path',
            source_value: 'src/**',
            target_doc_id: 'doc-1',
            edge_type: 'path_requires',
            priority: 1,
            specificity: 0,
          },
        ],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('boot');
    d.close();

    const r = spawnSync(execPath, [MAIN_JS, 'share-export', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('share-export');
    expect(r.stdout).toContain('Done.');
    expect(existsSync(join(dir, 'aegis-share', 'manifest.json'))).toBe(true);
    expect(existsSync(join(dir, 'aegis-share', 'canonical.json'))).toBe(true);
  }, 15_000);

  it('exports to custom --out directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-share-out-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const dbPath = join(dir, '.aegis', 'aegis.db');
    const d = await createDatabase(dbPath);
    const repo = new Repository(d);
    repo.insertProposal({
      proposal_id: 'boot',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [{ doc_id: 'doc-1', title: 'D1', kind: 'guideline', content: 'c', content_hash: hash('c') }],
        edges: [],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('boot');
    d.close();

    const customOut = join(dir, 'custom-share');
    const r = spawnSync(execPath, [MAIN_JS, 'share-export', '--project-root', dir, '--out', customOut], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(existsSync(join(customOut, 'manifest.json'))).toBe(true);
    expect(existsSync(join(customOut, 'canonical.json'))).toBe(true);

    // Verify manifest content
    const manifest = JSON.parse(readFileSync(join(customOut, 'manifest.json'), 'utf-8'));
    expect(manifest.format_version).toBe(1);
    expect(manifest.knowledge_version).toBe(1);
  }, 15_000);

  it('exits 1 when DB does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-share-nodb-'));
    const r = spawnSync(execPath, [MAIN_JS, 'share-export', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain('Database not found');
  });
});

describe('CLI — share-hydrate (dist/main.js)', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Bootstrap an initialized DB, export a bundle, and return the bundle dir. */
  async function prepareBundle(projectRoot: string): Promise<string> {
    mkdirSync(join(projectRoot, '.aegis'), { recursive: true });
    const dbPath = join(projectRoot, '.aegis', 'aegis.db');
    const d = await createDatabase(dbPath);
    const repo = new Repository(d);
    repo.insertProposal({
      proposal_id: 'boot',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [{ doc_id: 'doc-1', title: 'D1', kind: 'guideline', content: 'c', content_hash: hash('c') }],
        edges: [
          {
            edge_id: 'e1',
            source_type: 'path',
            source_value: 'src/**',
            target_doc_id: 'doc-1',
            edge_type: 'path_requires',
            priority: 1,
            specificity: 0,
          },
        ],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('boot');
    d.close();

    // Export bundle
    const r = spawnSync(execPath, [MAIN_JS, 'share-export', '--project-root', projectRoot], {
      encoding: 'utf-8',
    });
    expect(r.status, `share-export stderr: ${r.stderr}`).toBe(0);
    return join(projectRoot, 'aegis-share');
  }

  it('hydrates into default .aegis/aegis.db on fresh project (no pre-existing .aegis/)', async () => {
    // Prepare source project with bundle
    const srcDir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-src-'));
    const bundleDir = await prepareBundle(srcDir);

    // Target project has NO .aegis/ directory — simulates fresh clone
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-fresh-'));

    const r = spawnSync(execPath, [MAIN_JS, 'share-hydrate', '--project-root', dir, '--bundle-dir', bundleDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('share-hydrate');
    expect(r.stdout).toContain('Done.');
    expect(existsSync(join(dir, '.aegis', 'aegis.db'))).toBe(true);

    rmSync(srcDir, { recursive: true, force: true });
  }, 30_000);

  it('fails without --replace when target DB exists', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-noreplace-'));
    const bundleDir = await prepareBundle(dir);

    // DB already exists from prepareBundle — hydrate without --replace should fail
    const r = spawnSync(execPath, [MAIN_JS, 'share-hydrate', '--project-root', dir, '--bundle-dir', bundleDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain('--replace');
  }, 30_000);

  it('succeeds with --replace when target DB exists', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-replace-'));
    const bundleDir = await prepareBundle(dir);

    const r = spawnSync(
      execPath,
      [MAIN_JS, 'share-hydrate', '--project-root', dir, '--bundle-dir', bundleDir, '--replace'],
      { encoding: 'utf-8' },
    );
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('share-hydrate');
  }, 30_000);

  it('exits 1 when bundle dir has no manifest', () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-nomanifest-'));
    const emptyBundleDir = join(dir, 'empty-bundle');
    mkdirSync(emptyBundleDir, { recursive: true });

    const r = spawnSync(execPath, [MAIN_JS, 'share-hydrate', '--project-root', dir, '--bundle-dir', emptyBundleDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain('Manifest not found');
  });

  it('prints operational state warning', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-warn-'));
    const srcDir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-warn-src-'));
    const bundleDir = await prepareBundle(srcDir);

    const r = spawnSync(execPath, [MAIN_JS, 'share-hydrate', '--project-root', dir, '--bundle-dir', bundleDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('operational state');

    rmSync(srcDir, { recursive: true, force: true });
  }, 30_000);
});

describe('CLI — share-lint (dist/main.js)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-lint-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDoc(docId: string, frontmatter: Record<string, string | null>, body: string): void {
    mkdirSync(join(dir, 'documents'), { recursive: true });
    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${v === null ? 'null' : v}`)
      .join('\n');
    writeFileSync(join(dir, 'documents', `${docId}.md`), `---\n${fm}\n---\n${body}`);
  }

  function writeEdgeFile(filename: string, edges: unknown[]): void {
    mkdirSync(join(dir, 'edges'), { recursive: true });
    writeFileSync(join(dir, 'edges', filename), JSON.stringify(edges, null, 2));
  }

  function writeTagMappings(mappings: unknown[]): void {
    writeFileSync(join(dir, 'tag-mappings.json'), JSON.stringify(mappings, null, 2));
  }

  it('exits 0 for valid source tree', () => {
    writeDoc(
      'guide',
      {
        doc_id: 'guide',
        title: 'Guide',
        kind: 'guideline',
        ownership: 'standalone',
      },
      'Content',
    );
    writeEdgeFile('path-requires.json', [
      { edge_id: 'e1', source_value: 'src/**', target_doc_id: 'guide', priority: 1, specificity: 1 },
    ]);

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('All checks passed');
    expect(r.stdout).toContain('documents:');
  });

  it('exits 1 for dangling edge reference', () => {
    writeDoc(
      'doc-a',
      {
        doc_id: 'doc-a',
        title: 'A',
        kind: 'guideline',
        ownership: 'standalone',
      },
      'A',
    );
    writeEdgeFile('path-requires.json', [
      { edge_id: 'e1', source_value: 'src/**', target_doc_id: 'nonexistent', priority: 1, specificity: 1 },
    ]);

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('non-existent document');
    expect(r.stderr).toContain('nonexistent');
  });

  it('exits 1 for dangling tag_mapping reference', () => {
    writeTagMappings([{ tag: 'test', doc_id: 'missing', confidence: 0.9, source: 'manual' }]);

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('non-existent document');
    expect(r.stderr).toContain('missing');
  });

  it('exits 1 for malformed JSON', () => {
    mkdirSync(join(dir, 'edges'), { recursive: true });
    writeFileSync(join(dir, 'edges', 'path-requires.json'), '{ broken }');

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error(s) found');
  });

  it('uses default source dir (aegis-share/source/) with --project-root', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'aegis-cli-lint-proj-'));
    const sourceSubDir = join(projectDir, 'aegis-share', 'source');
    mkdirSync(join(sourceSubDir, 'documents'), { recursive: true });
    const fm = 'doc_id: hello\ntitle: Hello\nkind: guideline\nownership: standalone';
    writeFileSync(join(sourceSubDir, 'documents', 'hello.md'), `---\n${fm}\n---\nHello body`);

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--project-root', projectDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('All checks passed');

    rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits 1 for duplicate doc_id across files', () => {
    writeDoc(
      'real',
      {
        doc_id: 'real',
        title: 'Real',
        kind: 'guideline',
        ownership: 'standalone',
      },
      'First',
    );
    // alias.md with same doc_id → duplicate
    writeFileSync(
      join(dir, 'documents', 'alias.md'),
      '---\ndoc_id: real\ntitle: Alias\nkind: guideline\nownership: standalone\n---\nSecond',
    );

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('duplicate doc_id');
    expect(r.stderr).toContain('real');
  });

  it('reports error count in summary', () => {
    writeEdgeFile('path-requires.json', [
      { edge_id: 'e1', source_value: 'a/**', target_doc_id: 'ghost-a', priority: 1, specificity: 1 },
      { edge_id: 'e2', source_value: 'b/**', target_doc_id: 'ghost-b', priority: 1, specificity: 1 },
    ]);

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('2 error(s) found');
  });
});

describe('CLI — share-format (dist/main.js)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-format-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDoc(docId: string, frontmatter: Record<string, string | null>, body: string): void {
    mkdirSync(join(dir, 'documents'), { recursive: true });
    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${v === null ? 'null' : v}`)
      .join('\n');
    writeFileSync(join(dir, 'documents', `${docId}.md`), `---\n${fm}\n---\n${body}`);
  }

  it('exits 0 and formats source tree', () => {
    // Write with scrambled key order
    writeDoc('guide', { ownership: 'standalone', title: 'Guide', kind: 'guideline', doc_id: 'guide' }, 'Content.\n');

    const r = spawnSync(execPath, [MAIN_JS, 'share-format', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('share-format');
    expect(r.stdout).toContain('files_changed');
    expect(r.stdout).toContain('Done.');

    // Verify file was reformatted
    const content = readFileSync(join(dir, 'documents', 'guide.md'), 'utf-8');
    const lines = content.split('\n');
    expect(lines[1]).toMatch(/^doc_id:/);
    expect(lines[2]).toMatch(/^title:/);
  });

  it('second run reports 0 files changed', () => {
    writeDoc('guide', { ownership: 'standalone', title: 'Guide', kind: 'guideline', doc_id: 'guide' }, 'Content.\n');

    // First run
    spawnSync(execPath, [MAIN_JS, 'share-format', '--source-dir', dir], { encoding: 'utf-8' });

    // Second run
    const r = spawnSync(execPath, [MAIN_JS, 'share-format', '--source-dir', dir], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('files_changed:   0');
  });

  it('uses default source dir with --project-root', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'aegis-cli-format-proj-'));
    const sourceSubDir = join(projectDir, 'aegis-share', 'source');
    mkdirSync(join(sourceSubDir, 'documents'), { recursive: true });
    const fm = 'doc_id: hello\ntitle: Hello\nkind: guideline\nownership: standalone';
    writeFileSync(join(sourceSubDir, 'documents', 'hello.md'), `---\n${fm}\n---\nBody.\n`);

    const r = spawnSync(execPath, [MAIN_JS, 'share-format', '--project-root', projectDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('Done.');

    rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits 1 for non-existent source directory', () => {
    const r = spawnSync(execPath, [MAIN_JS, 'share-format', '--source-dir', '/tmp/nonexistent-xxx'], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('share-format failed');
  });
});

describe('CLI — share-materialize (dist/main.js)', () => {
  let projectDir: string;
  let dbPath: string;

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'aegis-cli-materialize-'));
    mkdirSync(join(projectDir, '.aegis'), { recursive: true });
    dbPath = join(projectDir, '.aegis', 'aegis.db');

    // Bootstrap a minimal DB
    const db = await createDatabase(dbPath);
    const repo = new Repository(db);
    repo.insertProposal({
      proposal_id: 'boot',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [{ doc_id: 'seed', title: 'Seed', kind: 'guideline', content: 'seed', content_hash: hash('seed') }],
        edges: [],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('boot');
    db.close();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeSourceDoc(docId: string, frontmatter: Record<string, string | null>, body: string): void {
    const docsDir = join(projectDir, 'aegis-share', 'source', 'documents');
    mkdirSync(docsDir, { recursive: true });
    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${v === null ? 'null' : v}`)
      .join('\n');
    writeFileSync(join(docsDir, `${docId}.md`), `---\n${fm}\n---\n${body}`);
  }

  it('exits 0 and reports changes for valid source', () => {
    writeSourceDoc(
      'seed',
      { doc_id: 'seed', title: 'Seed', kind: 'guideline', ownership: 'standalone' },
      'updated seed',
    );
    writeSourceDoc(
      'new-doc',
      { doc_id: 'new-doc', title: 'New', kind: 'pattern', ownership: 'standalone' },
      'new body',
    );

    const r = spawnSync(execPath, [MAIN_JS, 'share-materialize', '--project-root', projectDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('share-materialize');
    expect(r.stdout).toContain('knowledge_version:');
    expect(r.stdout).toContain('Done.');
  }, 15_000);

  it('dry-run does not modify DB', () => {
    writeSourceDoc('seed', { doc_id: 'seed', title: 'Seed', kind: 'guideline', ownership: 'standalone' }, 'changed');

    const r = spawnSync(execPath, [MAIN_JS, 'share-materialize', '--project-root', projectDir, '--dry-run'], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('dry-run');
    expect(r.stdout).toContain('documents:');
  }, 15_000);

  it('exits 1 when DB does not exist', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'aegis-cli-mat-empty-'));
    const sourceSubDir = join(emptyDir, 'aegis-share', 'source', 'documents');
    mkdirSync(sourceSubDir, { recursive: true });
    writeFileSync(
      join(sourceSubDir, 'doc.md'),
      '---\ndoc_id: doc\ntitle: Doc\nkind: guideline\nownership: standalone\n---\nbody',
    );

    const r = spawnSync(execPath, [MAIN_JS, 'share-materialize', '--project-root', emptyDir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Database not found');

    rmSync(emptyDir, { recursive: true, force: true });
  }, 15_000);

  it('exits 1 for malformed source', () => {
    const docsDir = join(projectDir, 'aegis-share', 'source', 'documents');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'bad.md'), '---\ndoc_id: bad\n---\nno title or kind');

    const r = spawnSync(execPath, [MAIN_JS, 'share-materialize', '--project-root', projectDir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('share-materialize failed');
  }, 15_000);
});

describe('CLI — share-source-export (dist/main.js)', () => {
  let projectDir: string;
  let dbPath: string;

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'aegis-cli-source-export-'));
    mkdirSync(join(projectDir, '.aegis'), { recursive: true });
    dbPath = join(projectDir, '.aegis', 'aegis.db');

    const db = await createDatabase(dbPath);
    const repo = new Repository(db);
    repo.insertProposal({
      proposal_id: 'boot',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [
          { doc_id: 'guide', title: 'Guide', kind: 'guideline', content: 'Body.', content_hash: hash('Body.') },
        ],
        edges: [
          {
            edge_id: 'e1',
            source_type: 'path',
            source_value: 'src/**',
            target_doc_id: 'guide',
            edge_type: 'path_requires',
            priority: 1,
            specificity: 0,
          },
        ],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('boot');
    db.close();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits 0 and creates source files', () => {
    const r = spawnSync(execPath, [MAIN_JS, 'share-source-export', '--project-root', projectDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('share-source-export');
    expect(r.stdout).toContain('documents:');
    expect(r.stdout).toContain('Done.');

    // Verify files were created
    expect(existsSync(join(projectDir, 'aegis-share', 'source', 'documents', 'guide.md'))).toBe(true);
    expect(existsSync(join(projectDir, 'aegis-share', 'source', 'edges', 'path-requires.json'))).toBe(true);
  }, 15_000);

  it('exits 1 when DB does not exist', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'aegis-cli-srcexp-empty-'));
    const r = spawnSync(execPath, [MAIN_JS, 'share-source-export', '--project-root', emptyDir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Database not found');
    rmSync(emptyDir, { recursive: true, force: true });
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 001-aegis-perf-upgrade (T011): `maintenance` scan summary line.
// Requires `pnpm run build` beforehand (spawns dist/main.js). T018 / T025 append further cases here.
// ---------------------------------------------------------------------------

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliResult {
  const r = spawnSync(execPath, [MAIN_JS, ...args], { cwd: process.cwd(), encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('CLI — maintenance scan summary (dist/main.js)', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-cli-maint-'));
    const init = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf-8' });
    expect(init.status, `git init stderr: ${init.stderr}`).toBe(0);
    mkdirSync(join(root, '.aegis'), { recursive: true });
    const db = await createDatabase(join(root, '.aegis', 'aegis.db'));
    const repo = new Repository(db);
    repo.bumpVersionAndSnapshot();
    // Release file + advisory lock before spawning CLI.
    db.close();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('maintenance --dry-run prints a scan line right after the semantic staleness line', () => {
    const r = runCli(['maintenance', '--dry-run', '--project-root', root]);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const lines = r.stdout.split('\n');
    const idx = lines.findIndex((l) => l.includes('semantic staleness (015-10-3):'));
    expect(idx, `stdout: ${r.stdout}`).toBeGreaterThanOrEqual(0);
    expect(lines[idx + 1]).toMatch(/^ {3}scan: \d+ file\(s\) listed via (git|walk), \d+ fingerprint\(s\) computed$/);
    expect(lines[idx + 1]).toContain('listed via git');
  }, 30_000);

  // T025 (US4): `6. db_compaction` section after `5. co_change_cache`.
  it('maintenance --dry-run prints a 6. db_compaction section after 5. co_change_cache (vacuumed: false)', () => {
    const r = runCli(['maintenance', '--dry-run', '--project-root', root]);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const out = r.stdout;
    expect(out).toMatch(/^6\. db_compaction$/m);
    expect(out).toMatch(/^ {3}pages: \d+, free: \d+ \(\d+ bytes, \d\.\d{3}\)$/m);
    expect(out).toMatch(/^ {3}threshold_met: (true|false), vacuumed: (true|false)$/m);
    const coChangeAt = out.search(/^5\. co_change_cache$/m);
    const compactionAt = out.search(/^6\. db_compaction$/m);
    expect(coChangeAt, `stdout: ${out}`).toBeGreaterThanOrEqual(0);
    expect(compactionAt).toBeGreaterThan(coChangeAt);
    // Exact shape: blank line, heading, then the two detail lines.
    expect(out).toMatch(
      /\n\n6\. db_compaction\n {3}pages: \d+, free: \d+ \(\d+ bytes, \d\.\d{3}\)\n {3}threshold_met: (true|false), vacuumed: false\n/,
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 001-aegis-perf-upgrade (T018): `approve-pending` subcommand.
// Requires `pnpm run build` beforehand (spawns dist/main.js).
// ---------------------------------------------------------------------------

describe('CLI — approve-pending (dist/main.js)', () => {
  let root: string;
  let dbPath: string;

  /** Opens the project DB, applies `fn`, and closes it so the CLI child process can open the file. */
  async function withRepo(fn: (repo: Repository) => void): Promise<void> {
    const db = await createDatabase(dbPath);
    try {
      fn(new Repository(db));
    } finally {
      db.close();
    }
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-cli-approve-'));
    mkdirSync(join(root, '.aegis'), { recursive: true });
    dbPath = join(root, '.aegis', 'aegis.db');
    await withRepo((repo) => {
      repo.bumpVersionAndSnapshot();
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exits 2 on usage errors: unknown --types value, unknown flag, missing --types value', () => {
    const base = ['approve-pending', '--project-root', root];
    expect(runCli([...base, '--types', 'foo']).status).toBe(2);
    expect(runCli([...base, '--bogus']).status).toBe(2);
    expect(runCli(['approve-pending', '--project-root', root, '--types']).status).toBe(2);
    expect(runCli([...base, '--types', '--dry-run']).status).toBe(2);
  }, 30_000);

  it('exits 2 and reports "Database not found" when the DB file is missing', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'aegis-cli-approve-nodb-'));
    try {
      const r = runCli(['approve-pending', '--project-root', emptyRoot]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('[aegis] Database not found at');
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('exits 0 with an empty "approved" list and a summary line when nothing is pending', () => {
    const r = runCli(['approve-pending', '--project-root', root]);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const result = JSON.parse(r.stdout) as { approved: unknown[]; dry_run: boolean };
    expect(result.approved).toEqual([]);
    expect(result.dry_run).toBe(false);
    const lines = r.stderr.trim().split('\n');
    expect(lines[lines.length - 1]).toBe(
      '[aegis] approve-pending: approved=0 failed=0 rejected=0 skipped=0 (dry_run=false)',
    );
  }, 15_000);

  it('--dry-run lists a pending new_doc in would_approve and leaves it pending', async () => {
    await withRepo((repo) => {
      repo.insertProposal({
        proposal_id: 'p-newdoc',
        proposal_type: 'new_doc',
        payload: JSON.stringify({
          doc_id: 'guide',
          title: 'Guide',
          kind: 'guideline',
          content: 'Body.',
          content_hash: hash('Body.'),
        }),
        status: 'pending',
        review_comment: null,
      });
    });

    const r = runCli(['approve-pending', '--dry-run', '--project-root', root]);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const result = JSON.parse(r.stdout) as { dry_run: boolean; would_approve: { proposal_id: string }[] };
    expect(result.dry_run).toBe(true);
    expect(result.would_approve).toHaveLength(1);
    expect(result.would_approve[0].proposal_id).toBe('p-newdoc');

    await withRepo((repo) => {
      expect(repo.getProposal('p-newdoc')?.status).toBe('pending');
    });
  }, 15_000);

  it('exits 1 and reports "failed" when an add_edge targets a missing document', async () => {
    await withRepo((repo) => {
      repo.insertProposal({
        proposal_id: 'p-badedge',
        proposal_type: 'add_edge',
        payload: JSON.stringify({
          edge_id: 'e-bad',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'does-not-exist',
          edge_type: 'path_requires',
          priority: 1,
          specificity: 0,
        }),
        status: 'pending',
        review_comment: null,
      });
    });

    const r = runCli(['approve-pending', '--project-root', root]);
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(1);
    const result = JSON.parse(r.stdout) as { failed: { proposal_id: string }[] };
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].proposal_id).toBe('p-badedge');
    expect(r.stderr).toContain('[aegis] approve-pending: p-badedge failed:');
  }, 15_000);

  it('keeps the full JSON on stdout (> 64 KiB) when exiting 1 with failures', async () => {
    const count = 2000;
    await withRepo((repo) => {
      for (let i = 0; i < count; i++) {
        repo.insertProposal({
          proposal_id: `p-bad-${String(i).padStart(3, '0')}`,
          proposal_type: 'add_edge',
          payload: JSON.stringify({
            edge_id: `e-bad-${i}`,
            source_type: 'path',
            source_value: `src/${'x'.repeat(40)}-${i}/**`,
            target_doc_id: 'does-not-exist',
            edge_type: 'path_requires',
            priority: 1,
            specificity: 0,
          }),
          status: 'pending',
          review_comment: null,
        });
      }
    });

    // runCli's default maxBuffer (1 MiB) is too small for stdout + one stack trace per failure on stderr.
    const spawned = spawnSync(execPath, [MAIN_JS, 'approve-pending', '--project-root', root], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
    });
    const r = { status: spawned.status, stdout: spawned.stdout ?? '', stderr: spawned.stderr ?? '' };
    expect(r.status, `stderr: ${r.stderr.slice(-500)}`).toBe(1);
    expect(r.stdout.length).toBeGreaterThan(65_536);
    const result = JSON.parse(r.stdout) as { failed: unknown[] };
    expect(result.failed).toHaveLength(count);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// `staleness-ack` subcommand (admin CLI only). Requires `pnpm run build` beforehand.
// ---------------------------------------------------------------------------

describe('CLI — staleness-ack (dist/main.js)', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-cli-ack-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export function A() {}\n', 'utf-8');
    const init = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf-8' });
    expect(init.status, `git init stderr: ${init.stderr}`).toBe(0);
    mkdirSync(join(root, '.aegis'), { recursive: true });
    const db = await createDatabase(join(root, '.aegis', 'aegis.db'));
    const repo = new Repository(db);
    repo.insertProposal({
      proposal_id: 'p-boot',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [{ doc_id: 'doc-a', title: 'A', kind: 'guideline', content: 'a', content_hash: hash('a') }],
        edges: [
          {
            edge_id: 'e-a',
            source_type: 'path',
            source_value: 'src/**',
            target_doc_id: 'doc-a',
            edge_type: 'path_requires',
            priority: 100,
            specificity: 0,
          },
        ],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('p-boot');
    db.close();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exits 2 on usage errors: neither or both of --doc-ids/--all, unknown flag, missing value', () => {
    const base = ['staleness-ack', '--project-root', root];
    expect(runCli(base).status).toBe(2);
    expect(runCli([...base, '--all', '--doc-ids', 'doc-a']).status).toBe(2);
    expect(runCli([...base, '--all', '--bogus']).status).toBe(2);
    expect(runCli([...base, '--doc-ids']).status).toBe(2);
    expect(runCli([...base, '--doc-ids', ',']).status).toBe(2);
  }, 30_000);

  it('exits 2 for a doc_id that is not an approved document', () => {
    const r = runCli(['staleness-ack', '--project-root', root, '--doc-ids', 'nope']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('nope');
  }, 30_000);

  it('prints the result JSON and writes the baseline (none in dry-run)', async () => {
    const dry = runCli(['staleness-ack', '--project-root', root, '--doc-ids', 'doc-a', '--dry-run']);
    expect(dry.status, `stderr: ${dry.stderr}`).toBe(0);
    const dryResult = JSON.parse(dry.stdout) as { dry_run: boolean; acknowledged: Array<{ doc_id: string }> };
    expect(dryResult.dry_run).toBe(true);
    expect(dryResult.acknowledged.map((a) => a.doc_id)).toEqual(['doc-a']);

    const readBaseline = async (): Promise<string | null> => {
      const db = await createDatabase(join(root, '.aegis', 'aegis.db'));
      try {
        return new Repository(db).getStalenessBaseline('doc-a');
      } finally {
        db.close();
      }
    };
    expect(await readBaseline()).toBeNull();

    const r = runCli(['staleness-ack', '--project-root', root, '--all']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ dry_run: false, skipped: [], archived_observations: 0 });
    expect(await readBaseline()).toContain('src/a.ts');
  }, 30_000);
});

describe('MCP server startup — dormant mode gate (dist/main.js)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-startup-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Spawns the agent-surface server, waits for the startup line on stderr, kills it, and returns stderr. */
  function startAndKill(projectRoot: string, extraArgs: string[] = []): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(execPath, [MAIN_JS, '--surface', 'agent', '--project-root', projectRoot, ...extraArgs], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        if (err) reject(err);
        else resolvePromise(stderr);
      };
      const timer = setTimeout(() => finish(new Error(`startup timeout; stderr: ${stderr}`)), 12_000);
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.includes('Aegis MCP server started')) finish();
      });
      child.on('error', (e) => finish(e));
      child.on('exit', () => finish(new Error(`exited before startup; stderr: ${stderr}`)));
    });
  }

  it('starts in dormant mode and writes nothing when no install marker exists', async () => {
    const stderr = await startAndKill(dir);
    expect(stderr).toContain('Dormant mode');
    expect(stderr).toContain('(surface: agent, dormant)');
    expect(readdirSync(dir)).toEqual([]);
  }, 15_000);

  it('starts in dormant mode when CLAUDE.md has no install marker line', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# x\n');
    const stderr = await startAndKill(dir);
    expect(stderr).toContain('Dormant mode');
    expect(readdirSync(dir)).toEqual(['CLAUDE.md']);
  }, 15_000);

  it('creates .aegis/ with .gitignore and aegis.db when CLAUDE.md has the install marker line', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'aegis: 導入済み\n');
    const stderr = await startAndKill(dir);
    expect(stderr).not.toContain('Dormant mode');
    expect(existsSync(join(dir, '.aegis', 'aegis.db'))).toBe(true);
    expect(readFileSync(join(dir, '.aegis', '.gitignore'), 'utf-8')).toBe('*\n');
  }, 15_000);

  it('opens .aegis/aegis.db as before when .aegis/ exists without the marker line', async () => {
    mkdirSync(join(dir, '.aegis'));
    const stderr = await startAndKill(dir);
    expect(stderr).not.toContain('Dormant mode');
    expect(existsSync(join(dir, '.aegis', 'aegis.db'))).toBe(true);
    expect(existsSync(join(dir, '.aegis', '.gitignore'))).toBe(true);
  }, 15_000);

  it('uses the explicit --db path without checking the install marker', async () => {
    const stderr = await startAndKill(dir, ['--db', join(dir, 'custom', 'x.db')]);
    expect(stderr).not.toContain('Dormant mode');
    expect(existsSync(join(dir, 'custom', 'x.db'))).toBe(true);
    expect(existsSync(join(dir, 'custom', '.gitignore'))).toBe(true);
    expect(existsSync(join(dir, '.aegis'))).toBe(false);
  }, 15_000);
});

describe('CLI — edges (dist/main.js)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-edges-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const db = await createDatabase(join(dir, '.aegis', 'aegis.db'));
    const repo = new Repository(db);
    bootstrap(repo, {
      documents: [{ doc_id: 'doc-a', title: 'A', kind: 'guideline', content: 'A', source_path: 'docs/a.md' }],
      edges: [
        {
          edge_id: 'e-1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'doc-a',
          edge_type: 'path_requires',
          priority: 100,
        },
      ],
    });
    // Release the file + advisory lock before spawning the CLI.
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints the edge list as JSON, deterministically', () => {
    const args = [MAIN_JS, 'edges', '--json', '--project-root', dir];
    const r1 = spawnSync(execPath, args, { encoding: 'utf-8' });
    expect(r1.status, `stderr: ${r1.stderr}`).toBe(0);
    expect(r1.stderr).toBe('');
    const body = JSON.parse(r1.stdout) as { edges: { edge_id: string; source_path: string | null }[] };
    expect(body.edges.map((e) => e.edge_id)).toEqual(['e-1']);
    expect(body.edges[0].source_path).toBe('docs/a.md');
    const r2 = spawnSync(execPath, args, { encoding: 'utf-8' });
    expect(r2.stdout).toBe(r1.stdout);
  }, 15_000);

  it('exits 2 when --json is missing', () => {
    const r = spawnSync(execPath, [MAIN_JS, 'edges', '--project-root', dir], { encoding: 'utf-8' });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim()).toBe('[aegis] edges: --json is required');
  }, 15_000);

  it('exits 2 without creating .aegis/ when the DB does not exist', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'aegis-cli-edges-empty-'));
    try {
      const r = spawnSync(execPath, [MAIN_JS, 'edges', '--json', '--project-root', emptyDir], {
        encoding: 'utf-8',
      });
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('Database not found');
      expect(existsSync(join(emptyDir, '.aegis'))).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('CLI — resolve (dist/main.js)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-resolve-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const db = await createDatabase(join(dir, '.aegis', 'aegis.db'));
    const repo = new Repository(db);
    bootstrap(repo, {
      documents: [{ doc_id: 'doc-a', title: 'A', kind: 'guideline', content: 'A', source_path: 'docs/a.md' }],
      edges: [
        {
          edge_id: 'e-1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'doc-a',
          edge_type: 'path_requires',
          priority: 100,
        },
      ],
    });
    // Release the file + advisory lock before spawning the CLI.
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves each path, normalizing before matching', () => {
    const r = spawnSync(
      execPath,
      [MAIN_JS, 'resolve', 'src/main.ts', './src/main.ts', 'no/such.txt', '--project-root', dir],
      { encoding: 'utf-8' },
    );
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stderr).toBe('');
    const body = JSON.parse(r.stdout) as {
      results: {
        path: string;
        normalized_path: string;
        documents: { doc_id: string; source_path: string | null }[];
      }[];
    };
    expect(body.results.length).toBe(3);
    expect(body.results[0].documents.map((d) => d.doc_id)).toEqual(['doc-a']);
    expect(body.results[0].documents[0].source_path).toBe('docs/a.md');
    expect(body.results[1].normalized_path).toBe('src/main.ts');
    expect(body.results[1].documents).toEqual(body.results[0].documents);
    expect(body.results[2].documents).toEqual([]);
  }, 15_000);

  it('exits 2 when no path is given', () => {
    const r = spawnSync(execPath, [MAIN_JS, 'resolve', '--project-root', dir], { encoding: 'utf-8' });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim()).toBe('[aegis] resolve: at least one <path> is required');
  }, 15_000);

  it('exits 2 when a path is outside the project root', () => {
    const r = spawnSync(execPath, [MAIN_JS, 'resolve', '../x.ts', '--project-root', dir], { encoding: 'utf-8' });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim()).toBe('[aegis] resolve: path is outside the project root: ../x.ts');
  }, 15_000);
});

describe('CLI — edges / resolve are read-only (dist/main.js)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-readonly-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const db = await createDatabase(join(dir, '.aegis', 'aegis.db'));
    const repo = new Repository(db);
    bootstrap(repo, {
      documents: [{ doc_id: 'doc-a', title: 'A', kind: 'guideline', content: 'A', source_path: 'docs/a.md' }],
      edges: [
        {
          edge_id: 'e-1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'doc-a',
          edge_type: 'path_requires',
          priority: 100,
        },
      ],
    });
    // Release the file + advisory lock before spawning the CLI.
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function aegisDirState(root: string): { sha: string; mtimeMs: number; entries: string[] } {
    const dbPath = join(root, '.aegis', 'aegis.db');
    return {
      sha: createHash('sha256').update(readFileSync(dbPath)).digest('hex'),
      mtimeMs: statSync(dbPath).mtimeMs,
      entries: readdirSync(join(root, '.aegis')).sort(),
    };
  }

  it('leaves the DB bytes, mtime and .aegis/ entries unchanged', () => {
    const before = aegisDirState(dir);
    const e = spawnSync(execPath, [MAIN_JS, 'edges', '--json', '--project-root', dir], { encoding: 'utf-8' });
    const r = spawnSync(execPath, [MAIN_JS, 'resolve', 'src/main.ts', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(e.status, `stderr: ${e.stderr}`).toBe(0);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(aegisDirState(dir)).toEqual(before);
  }, 15_000);

  it('does not take the advisory lock (a fresh lock file does not block or get removed)', () => {
    // Fresh mtime: not discarded as stale (LOCK_STALE_MS = 30_000), so an implementation
    // that acquired the lock would wait LOCK_TIMEOUT_MS = 5_000 and fail.
    const lockPath = join(dir, '.aegis', 'aegis.db.lock');
    writeFileSync(lockPath, '');
    const t0 = Date.now();
    const e = spawnSync(execPath, [MAIN_JS, 'edges', '--json', '--project-root', dir], {
      encoding: 'utf-8',
      timeout: 4_000,
    });
    const r = spawnSync(execPath, [MAIN_JS, 'resolve', 'src/main.ts', '--project-root', dir], {
      encoding: 'utf-8',
      timeout: 4_000,
    });
    const elapsed = Date.now() - t0;
    expect(e.status, `stderr: ${e.stderr}`).toBe(0);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(elapsed).toBeLessThan(3_000);
    expect(existsSync(lockPath)).toBe(true);
  }, 15_000);

  it('exits 2 and creates nothing when the DB does not exist', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'aegis-cli-readonly-empty-'));
    try {
      const e = spawnSync(execPath, [MAIN_JS, 'edges', '--json', '--project-root', emptyDir], {
        encoding: 'utf-8',
      });
      const r = spawnSync(execPath, [MAIN_JS, 'resolve', 'src/a.ts', '--project-root', emptyDir], {
        encoding: 'utf-8',
      });
      expect(e.status).toBe(2);
      expect(e.stdout).toBe('');
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(readdirSync(emptyDir)).toEqual([]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 15_000);
});
