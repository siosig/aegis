import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../core/store/index.js';
import { AegisService } from './services.js';

const TEMPLATES_ROOT = join(import.meta.dirname, '../../templates');

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

describe('AegisService.runMaintenance — semantic staleness scan_stats (US1)', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let projectRoot: string;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    projectRoot = mkdtempSync(join(tmpdir(), 'aegis-maintenance-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('reports git listing stats for a git work tree (ignored files excluded)', async () => {
    execFileSync('git', ['init', '-q'], { cwd: projectRoot });
    writeTree(projectRoot, {
      '.gitignore': 'ignored.log\nbuild-output/\n',
      'README.md': '# readme\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'ignored.log': 'noise\n',
      'build-output/x.js': 'noise\n',
    });
    const service = new AegisService(repo, TEMPLATES_ROOT, null, [], false, projectRoot);

    const r = await service.runMaintenance('admin', { dryRun: true });

    const semantic = r.staleness_report.semantic;
    expect(semantic?.algorithm_version).toBe('015-10-3');
    const stats = semantic?.scan_stats;
    expect(stats).toBeDefined();
    expect(stats?.listing_source).toBe('git');
    // .gitignore, README.md, src/a.ts, src/b.ts (ignored.log and build-output/ are excluded)
    expect(stats?.files_listed).toBe(4);
    expect(typeof stats?.fingerprints_computed).toBe('number');
  });

  it('reports walk listing stats for a non-git directory', async () => {
    writeTree(projectRoot, {
      'README.md': '# readme\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'node_modules/pkg/index.js': 'noise\n',
    });
    const service = new AegisService(repo, TEMPLATES_ROOT, null, [], false, projectRoot);

    const r = await service.runMaintenance('admin', { dryRun: true });

    const semantic = r.staleness_report.semantic;
    expect(semantic?.algorithm_version).toBe('015-10-3');
    const stats = semantic?.scan_stats;
    expect(stats).toBeDefined();
    expect(stats?.listing_source).toBe('walk');
    // node_modules is skipped by the walk fallback's built-in ignore list
    expect(stats?.files_listed).toBe(3);
    expect(typeof stats?.fingerprints_computed).toBe('number');
  });
});

describe('AegisService.runMaintenance — db_compaction (US4)', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let projectRoot: string;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    projectRoot = mkdtempSync(join(tmpdir(), 'aegis-maintenance-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('reports db_compaction with all report fields on a dry run, never vacuuming', async () => {
    const service = new AegisService(repo, TEMPLATES_ROOT, null, [], false, projectRoot);

    const r = await service.runMaintenance('admin', { dryRun: true });

    const c = r.db_compaction;
    expect(c).toBeDefined();
    expect(typeof c.page_count).toBe('number');
    expect(typeof c.freelist_count).toBe('number');
    expect(typeof c.page_size).toBe('number');
    expect(typeof c.free_bytes).toBe('number');
    expect(typeof c.free_ratio).toBe('number');
    expect(typeof c.threshold_met).toBe('boolean');
    expect(c.vacuumed).toBe(false);
  });

  it('reports db_compaction without vacuuming a small DB below the threshold on a real run', async () => {
    const service = new AegisService(repo, TEMPLATES_ROOT, null, [], false, projectRoot);

    const r = await service.runMaintenance('admin', { dryRun: false });

    const c = r.db_compaction;
    expect(c).toBeDefined();
    expect(typeof c.page_count).toBe('number');
    expect(typeof c.freelist_count).toBe('number');
    expect(typeof c.page_size).toBe('number');
    expect(typeof c.free_bytes).toBe('number');
    expect(typeof c.free_ratio).toBe('number');
    expect(c.threshold_met).toBe(false);
    expect(c.vacuumed).toBe(false);
  });
});
