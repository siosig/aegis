/**
 * Repository file listing for semantic staleness scans.
 *
 * Inside a git work tree the listing comes from `git ls-files` (tracked + untracked, honoring ignore rules);
 * outside a work tree (or without git) it falls back to a deterministic recursive walk.
 */

import { execFileSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Directory names excluded from staleness scans. */
export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.turbo',
  'target',
  'out',
  '.next',
  'build',
]);

export type RepoListingSource = 'git' | 'walk';

export interface RepoFileListing {
  /** Repo-relative posix paths, unique, ascending by localeCompare. */
  files: string[];
  source: RepoListingSource;
}

/** Thrown when `git ls-files` fails (non-zero exit, timeout, output overflow) inside a git work tree. */
export class RepoListingError extends Error {}

const GIT_LS_FILES_ARGS = ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
const GIT_LS_FILES_MAX_BUFFER = 512 * 1024 * 1024;
const GIT_LS_FILES_TIMEOUT_MS = 60_000;
const GIT_REV_PARSE_TIMEOUT_MS = 10_000;

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Lists regular files visible to git (tracked + untracked, not ignored) under projectRoot.
 * Returns null when projectRoot is not inside a git work tree (or git is unavailable).
 * Throws RepoListingError when `git ls-files` itself fails inside a work tree.
 */
export function listGitVisibleFiles(projectRoot: string): string[] | null {
  const env = gitEnv();

  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: GIT_REV_PARSE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
    if (inside.trim() !== 'true') return null;
  } catch {
    return null;
  }

  // projectRoot may sit inside an outer work tree that ignores it (e.g. a dotfiles repo with `*`).
  // `git ls-files` would then list nothing; treat it as "not in a work tree" and fall back to the walk.
  try {
    execFileSync('git', ['check-ignore', '-q', '--', '.'], {
      cwd: projectRoot,
      timeout: GIT_REV_PARSE_TIMEOUT_MS,
      stdio: 'ignore',
      env,
    });
    return null; // exit 0: the root itself is ignored
  } catch {
    // exit 1 (not ignored) or any other failure: continue with git ls-files
  }

  let stdout: string;
  try {
    stdout = execFileSync('git', GIT_LS_FILES_ARGS, {
      cwd: projectRoot,
      encoding: 'utf-8',
      maxBuffer: GIT_LS_FILES_MAX_BUFFER,
      timeout: GIT_LS_FILES_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
  } catch (err) {
    throw new RepoListingError(`git ls-files failed in '${projectRoot}': ${errorMessage(err)}`);
  }

  const unique = new Set<string>();
  for (const p of stdout.split('\0')) {
    if (p.length === 0) continue;
    unique.add(p);
  }

  const out: string[] = [];
  for (const p of unique) {
    if (p.split('/').some((seg) => SKIP_DIR_NAMES.has(seg))) continue;
    try {
      if (!lstatSync(join(projectRoot, p)).isFile()) continue;
    } catch {
      continue;
    }
    out.push(toPosix(p));
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/** Deterministic recursive listing of repo-relative file paths (posix-style). */
export function walkRepoFiles(projectRoot: string): string[] {
  const out: string[] = [];

  function walk(absDir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      const abs = join(absDir, ent.name);
      try {
        if (ent.isDirectory()) {
          walk(abs);
        } else if (ent.isFile()) {
          const rel = relative(projectRoot, abs);
          out.push(toPosix(rel));
        }
      } catch {
        /* unreadable entry */
      }
    }
  }

  try {
    walk(projectRoot);
  } catch {
    return [];
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/** git listing when inside a work tree (source: 'git'), otherwise the recursive walk (source: 'walk'). */
export function listRepoFiles(projectRoot: string): RepoFileListing {
  const gitFiles = listGitVisibleFiles(projectRoot);
  if (gitFiles !== null) return { files: gitFiles, source: 'git' };
  return { files: walkRepoFiles(projectRoot), source: 'walk' };
}

/**
 * Returns the subset of `paths` (repo-relative, posix) that the listing excludes by scope, whether or not the
 * file still exists: a path with a SKIP_DIR_NAMES segment, or (source 'git') a path git ignores.
 * A failing `git check-ignore` contributes nothing, so callers keep treating those paths as in scope.
 */
export function pathsOutsideListingScope(
  projectRoot: string,
  paths: readonly string[],
  source: RepoListingSource,
): Set<string> {
  const out = new Set<string>();
  const rest: string[] = [];
  for (const p of paths) {
    if (p.split('/').some((seg) => SKIP_DIR_NAMES.has(seg))) out.add(p);
    else rest.push(p);
  }
  if (source !== 'git' || rest.length === 0) return out;

  let stdout: string;
  try {
    stdout = execFileSync('git', ['check-ignore', '-z', '--stdin'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      input: `${rest.join('\0')}\0`,
      maxBuffer: GIT_LS_FILES_MAX_BUFFER,
      timeout: GIT_LS_FILES_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: gitEnv(),
    });
  } catch {
    // exit 1: none of the paths is ignored. Any other failure: report nothing as ignored.
    return out;
  }
  for (const p of stdout.split('\0')) {
    if (p.length > 0) out.add(p);
  }
  return out;
}

/** Backward-compatible: `listRepoFiles(projectRoot).files`. */
export function listRepoRelativeFiles(projectRoot: string): string[] {
  return listRepoFiles(projectRoot).files;
}
