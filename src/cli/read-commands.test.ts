import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../core/store/database.js';
import {
  type CliIo,
  CliUsageError,
  parseEdgesCli,
  parseResolveCli,
  runEdgesCli,
  runResolveCli,
} from './read-commands.js';

function fakeIo(): CliIo & { out: string[]; err: string[] } {
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
  };
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'aegis-cli-read-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('parseEdgesCli', () => {
  it('defaults projectRoot to cwd and dbPath to .aegis/aegis.db', () => {
    expect(parseEdgesCli(['--json'], cwd)).toEqual({
      projectRoot: cwd,
      dbPath: join(cwd, '.aegis', 'aegis.db'),
    });
  });

  it('resolves --project-root against cwd', () => {
    expect(parseEdgesCli(['--json', '--project-root', 'sub'], cwd)).toEqual({
      projectRoot: join(cwd, 'sub'),
      dbPath: join(cwd, 'sub', '.aegis', 'aegis.db'),
    });
  });

  it('resolves --db=<path> against cwd', () => {
    expect(parseEdgesCli(['--json', '--db=x.db'], cwd)).toEqual({
      projectRoot: cwd,
      dbPath: join(cwd, 'x.db'),
    });
  });

  it('accepts a repeated --json', () => {
    expect(parseEdgesCli(['--json', '--json'], cwd)).toEqual({
      projectRoot: cwd,
      dbPath: join(cwd, '.aegis', 'aegis.db'),
    });
  });

  it('rejects a missing --json', () => {
    expect(() => parseEdgesCli([], cwd)).toThrow(CliUsageError);
    expect(() => parseEdgesCli([], cwd)).toThrow('--json is required');
  });

  it.each([
    ['a positional argument', ['--json', 'extra']],
    ['an unknown option', ['--json', '--bogus']],
    ['--db without a value', ['--json', '--db']],
    ['--db followed by an option', ['--json', '--db', '--json']],
    ['--templates', ['--json', '--templates', 'x']],
    ['a short option', ['--json', '-j']],
  ])('rejects %s', (_label, args) => {
    expect(() => parseEdgesCli(args, cwd)).toThrow(CliUsageError);
  });

  it('rejects an empty --db value', () => {
    expect(() => parseEdgesCli(['--json', '--db='], cwd)).toThrow(CliUsageError);
    expect(() => parseEdgesCli(['--json', '--db='], cwd)).toThrow('--db requires a non-empty value');
  });

  it('rejects an empty --project-root value', () => {
    expect(() => parseEdgesCli(['--json', '--project-root='], cwd)).toThrow(CliUsageError);
    expect(() => parseEdgesCli(['--json', '--project-root='], cwd)).toThrow(
      '--project-root requires a non-empty value',
    );
  });
});

describe('runEdgesCli', () => {
  it('returns 2 and creates nothing when the database does not exist', async () => {
    const io = fakeIo();
    const code = await runEdgesCli(['--json', '--db', 'none.db'], io, cwd);
    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toEqual([`[aegis] Database not found at ${join(cwd, 'none.db')}`]);
    expect(existsSync(join(cwd, 'none.db'))).toBe(false);
    expect(existsSync(join(cwd, '.aegis'))).toBe(false);
  });

  it('returns 2 with a usage message when --json is missing', async () => {
    const io = fakeIo();
    const code = await runEdgesCli([], io, cwd);
    expect(code).toBe(2);
    expect(io.err).toEqual(['[aegis] edges: --json is required']);
    expect(io.out).toEqual([]);
  });

  it('prints an empty edge list as one JSON document for an empty database', async () => {
    const dbPath = join(cwd, 'a.db');
    const db = await createDatabase(dbPath);
    db.close();

    const io = fakeIo();
    const code = await runEdgesCli(['--json', '--db', dbPath], io, cwd);
    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    expect(io.out).toHaveLength(1);
    expect(io.out[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(io.out[0])).toEqual({ schema_version: 1, knowledge_version: 0, edges: [] });
  });

  it('returns 2 with a single-line error and no stdout for a corrupt database', async () => {
    const dbPath = join(cwd, 'bad.db');
    writeFileSync(dbPath, 'not sqlite');

    const io = fakeIo();
    const code = await runEdgesCli(['--json', '--db', dbPath], io, cwd);
    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toHaveLength(1);
    expect(io.err[0].startsWith('[aegis] edges: ')).toBe(true);
    expect(io.err[0]).not.toMatch(/\n/);
  });
});

describe('parseResolveCli', () => {
  it('defaults projectRoot to cwd and dbPath to .aegis/aegis.db', () => {
    expect(parseResolveCli(['a.ts'], cwd)).toEqual({
      projectRoot: cwd,
      dbPath: join(cwd, '.aegis', 'aegis.db'),
      paths: ['a.ts'],
    });
  });

  it('accepts --json anywhere and ignores it', () => {
    expect(parseResolveCli(['a.ts', '--json', 'b.ts'], cwd).paths).toEqual(['a.ts', 'b.ts']);
  });

  it('treats arguments after -- as paths', () => {
    expect(parseResolveCli(['--', '-x.ts'], cwd).paths).toEqual(['-x.ts']);
  });

  it('keeps duplicate paths', () => {
    expect(parseResolveCli(['a.ts', 'a.ts'], cwd).paths).toEqual(['a.ts', 'a.ts']);
  });

  it('resolves --db=<path> against cwd', () => {
    expect(parseResolveCli(['--db=x.db', 'p'], cwd).dbPath).toBe(join(cwd, 'x.db'));
  });

  it.each([
    ['no arguments', []],
    ['only --json', ['--json']],
  ])('rejects %s with the missing-path message', (_label, args) => {
    expect(() => parseResolveCli(args, cwd)).toThrow(CliUsageError);
    expect(() => parseResolveCli(args, cwd)).toThrow('at least one <path> is required');
  });

  it.each([
    ['an unknown option', ['a.ts', '--bogus']],
    ['--db without a value', ['a.ts', '--db']],
    ['--db followed by an option', ['a.ts', '--db', '--json']],
    ['an empty --db value', ['a.ts', '--db=']],
    ['--template-dir', ['a.ts', '--template-dir', 'x']],
  ])('rejects %s', (_label, args) => {
    expect(() => parseResolveCli(args, cwd)).toThrow(CliUsageError);
  });
});

describe('runResolveCli', () => {
  it('returns 2 for a path outside the project root before checking the database', async () => {
    const io = fakeIo();
    const code = await runResolveCli(['../x.ts', '--db', join(cwd, 'none.db')], io, cwd);
    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toEqual(['[aegis] resolve: path is outside the project root: ../x.ts']);
  });

  it('returns 2 and creates nothing when the database does not exist', async () => {
    const io = fakeIo();
    const code = await runResolveCli(['a.ts', '--db', join(cwd, 'none.db')], io, cwd);
    expect(code).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err).toEqual([`[aegis] Database not found at ${join(cwd, 'none.db')}`]);
    expect(existsSync(join(cwd, 'none.db'))).toBe(false);
  });

  it('returns 2 with a usage message when no path is given', async () => {
    const io = fakeIo();
    const code = await runResolveCli([], io, cwd);
    expect(code).toBe(2);
    expect(io.err).toEqual(['[aegis] resolve: at least one <path> is required']);
    expect(io.out).toEqual([]);
  });

  it('prints one result per input path, in order, for an uninitialized database', async () => {
    const dbPath = join(cwd, 'a.db');
    const db = await createDatabase(dbPath);
    db.close();

    const io = fakeIo();
    const code = await runResolveCli(['./src/a.ts', 'src/a.ts', '--db', dbPath], io, cwd);
    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]).results).toEqual([
      { path: './src/a.ts', normalized_path: 'src/a.ts', documents: [], resolution_path: [] },
      { path: 'src/a.ts', normalized_path: 'src/a.ts', documents: [], resolution_path: [] },
    ]);
  });
});
