/**
 * `--surface` argument of the entry point (src/main.ts), run as a child process via tsx.
 * V-6: `--surface ssa` starts a server exposing the 12 ssa tools.
 * V-7: an invalid surface value exits with code 1.
 * V-8: without an install marker, every surface starts in dormant mode with 2 tools.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..');

describe('main.ts --surface argument', () => {
  it('starts with --surface ssa and registers the 12 ssa tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-ssa-arg-'));
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), 'aegis: 導入済み\n');
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'src/main.ts', '--surface', 'ssa', '--project-root', dir],
        cwd: REPO_ROOT,
        stderr: 'ignore',
      });
      const client = new Client({ name: 'test-ssa-arg', version: '0.0.1' });
      await client.connect(transport);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name).sort();
        expect(names).toEqual(
          [
            // agent tools (6)
            'aegis_compile_context',
            'aegis_observe',
            'aegis_get_compile_audit',
            'aegis_get_known_tags',
            'aegis_workspace_status',
            'aegis_init_detect',
            // ssa extra tools (6)
            'aegis_list_proposals',
            'aegis_get_proposal',
            'aegis_archive_observations',
            'aegis_get_stats',
            'aegis_process_observations',
            'aegis_sync_docs',
          ].sort(),
        );
        expect(client.getServerVersion()?.name).toBe('aegis-ssa');
      } finally {
        await client.close();
      }
      expect(readdirSync(dir).sort()).toEqual(['.aegis', 'CLAUDE.md']);
      expect(existsSync(join(dir, '.aegis', 'aegis.db'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(['agent', 'ssa', 'admin'] as const)(
    'starts in dormant mode with --surface %s when Aegis is not installed',
    async (surface) => {
      const dir = mkdtempSync(join(tmpdir(), 'aegis-dormant-arg-'));
      try {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', 'src/main.ts', '--surface', surface, '--project-root', dir],
          cwd: REPO_ROOT,
          stderr: 'ignore',
        });
        const client = new Client({ name: 'test-dormant-arg', version: '0.0.1' });
        await client.connect(transport);
        try {
          const names = (await client.listTools()).tools.map((t) => t.name).sort();
          expect(names).toEqual(['aegis_init_detect', 'aegis_workspace_status']);
          expect(client.getServerVersion()?.name).toBe(`aegis-${surface}`);
        } finally {
          await client.close();
        }
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('exits with code 1 for an invalid surface value (SSA)', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--surface', 'SSA'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Invalid surface: SSA. Must be one of: agent, ssa, admin.');
  }, 30_000);
});
