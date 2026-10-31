import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listGitVisibleFiles,
  listRepoFiles,
  listRepoRelativeFiles,
  RepoListingError,
  SKIP_DIR_NAMES,
  walkRepoFiles,
} from './repo-file-listing.js';

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'aegis-repo-listing-'));
  tempRoots.push(root);
  return root;
}

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function gitInit(root: string): void {
  git(root, ['init', '-q']);
}

function write(root: string, rel: string, content = 'x'): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function sortedUnique(files: string[]): string[] {
  return [...new Set(files)].sort((a, b) => a.localeCompare(b));
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('optimization/repo-file-listing', () => {
  it('git work tree: lists tracked and untracked non-ignored files, excludes ignored ones', () => {
    const root = makeRoot();
    gitInit(root);
    write(root, '.gitignore', '.venv/\nignored.txt\n');
    write(root, 'src/a.ts');
    write(root, 'new.ts');
    write(root, '.venv/lib/x.py');
    write(root, 'ignored.txt');
    git(root, ['add', 'src/a.ts']);

    const listing = listRepoFiles(root);

    expect(listing.source).toBe('git');
    expect(listing.files).toContain('.gitignore');
    expect(listing.files).toContain('new.ts');
    expect(listing.files).toContain('src/a.ts');
    expect(listing.files.some((f) => f.startsWith('.venv/'))).toBe(false);
    expect(listing.files).not.toContain('ignored.txt');
    expect(listing.files).toEqual(sortedUnique(listing.files));
  });

  it('non-git directory: listGitVisibleFiles returns null and listRepoFiles falls back to the walk', () => {
    const root = makeRoot();
    write(root, 'src/a.ts');
    write(root, 'docs/guide.md');
    write(root, 'node_modules/pkg/index.js');
    write(root, 'top.txt');

    expect(listGitVisibleFiles(root)).toBeNull();

    const listing = listRepoFiles(root);
    expect(listing.source).toBe('walk');
    expect(listing.files).toEqual(walkRepoFiles(root));
    expect(listing.files).toContain('src/a.ts');
    expect(listing.files).toContain('docs/guide.md');
    expect(listing.files).toContain('top.txt');
    expect(listing.files.some((f) => f.startsWith('node_modules/'))).toBe(false);
  });

  it('non-git subdirectory inside an outer work tree that ignores it: falls back to the walk', () => {
    const outer = makeRoot();
    gitInit(outer);
    write(outer, '.gitignore', '*\n');
    write(outer, 'proj/src/a.ts');

    const proj = join(outer, 'proj');
    expect(listGitVisibleFiles(proj)).toBeNull();
    const listing = listRepoFiles(proj);
    expect(listing.source).toBe('walk');
    expect(listing.files).toContain('src/a.ts');
  });

  it('SKIP_DIR_NAMES holds exactly the nine names and tracked files under them are not listed', () => {
    expect([...SKIP_DIR_NAMES].sort()).toEqual(
      ['.git', 'node_modules', 'dist', 'coverage', '.turbo', 'target', 'out', '.next', 'build'].sort(),
    );
    expect(SKIP_DIR_NAMES.size).toBe(9);

    const root = makeRoot();
    gitInit(root);
    write(root, 'src/a.ts');
    write(root, 'node_modules/x.js');
    write(root, 'dist/y.js');
    git(root, ['add', 'src/a.ts']);
    git(root, ['add', '-f', 'node_modules/x.js', 'dist/y.js']);

    const listing = listRepoFiles(root);

    expect(listing.source).toBe('git');
    expect(listing.files).toContain('src/a.ts');
    expect(listing.files).not.toContain('node_modules/x.js');
    expect(listing.files).not.toContain('dist/y.js');
  });

  it('excludes tracked-but-deleted files and symlinks', () => {
    const root = makeRoot();
    gitInit(root);
    write(root, 'src/a.ts');
    write(root, 'gone.ts');
    symlinkSync('src/a.ts', join(root, 'tracked-link.ts'));
    git(root, ['add', 'src/a.ts', 'gone.ts', 'tracked-link.ts']);
    rmSync(join(root, 'gone.ts'));
    symlinkSync('src/a.ts', join(root, 'untracked-link.ts'));

    const listing = listRepoFiles(root);

    expect(listing.source).toBe('git');
    expect(listing.files).toContain('src/a.ts');
    expect(listing.files).not.toContain('gone.ts');
    expect(listing.files).not.toContain('tracked-link.ts');
    expect(listing.files).not.toContain('untracked-link.ts');
  });

  it('does not list more than 10,000 ignored files', { timeout: 60_000 }, () => {
    const root = makeRoot();
    gitInit(root);
    write(root, '.gitignore', '.venv/\n');
    write(root, 'src/a.ts');
    write(root, 'new.ts');
    git(root, ['add', 'src/a.ts']);
    mkdirSync(join(root, '.venv'), { recursive: true });
    for (let i = 0; i < 10_050; i++) {
      writeFileSync(join(root, '.venv', `f${i}.py`), '', 'utf-8');
    }

    const listing = listRepoFiles(root);

    // tracked: src/a.ts, untracked and not ignored: .gitignore, new.ts
    expect(listing.source).toBe('git');
    expect(listing.files).toHaveLength(3);
    expect(listing.files.some((f) => f.startsWith('.venv'))).toBe(false);
  });

  it('throws RepoListingError when git ls-files fails inside a work tree (no walk fallback)', () => {
    const root = makeRoot();
    gitInit(root);
    write(root, 'src/a.ts');
    git(root, ['add', 'src/a.ts']);
    writeFileSync(join(root, '.git', 'index'), Buffer.from([0xff, 0x00, 0xfe, 0x01, 0x02, 0x03, 0x04, 0x05]));

    expect(() => listGitVisibleFiles(root)).toThrow(RepoListingError);
    expect(() => listRepoFiles(root)).toThrow(RepoListingError);
    expect(() => listRepoRelativeFiles(root)).toThrow(RepoListingError);
  });

  it('listRepoRelativeFiles returns the same list as listRepoFiles(root).files', () => {
    const gitRoot = makeRoot();
    gitInit(gitRoot);
    write(gitRoot, 'src/a.ts');
    write(gitRoot, 'new.ts');
    git(gitRoot, ['add', 'src/a.ts']);
    expect(listRepoRelativeFiles(gitRoot)).toEqual(listRepoFiles(gitRoot).files);

    const plainRoot = makeRoot();
    write(plainRoot, 'src/b.ts');
    write(plainRoot, 'c.md');
    expect(listRepoRelativeFiles(plainRoot)).toEqual(listRepoFiles(plainRoot).files);
  });
});
