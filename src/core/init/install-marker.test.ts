import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DB_DIR,
  detectInstallMarker,
  formatDormantStartupMessage,
  INSTALL_MARKER_TEXT,
  resolveServerStartupMode,
} from './install-marker.js';

describe('install-marker', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-marker-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('1: reports dormant when nothing is present', () => {
    expect(detectInstallMarker(dir)).toEqual({ claudeMdMarker: false, aegisDirExists: false });
    expect(resolveServerStartupMode({ dbPathExplicit: false, projectRoot: dir })).toBe('dormant');
  });

  it('2: CLAUDE.md without the marker is dormant', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n\nsome text\n');
    expect(detectInstallMarker(dir).claudeMdMarker).toBe(false);
    expect(resolveServerStartupMode({ dbPathExplicit: false, projectRoot: dir })).toBe('dormant');
  });

  it('3: CLAUDE.md with the marker line is normal', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '- aegis: 導入済み。運用は ~/.claude/library/aegis.md に従う。\n');
    expect(detectInstallMarker(dir).claudeMdMarker).toBe(true);
    expect(resolveServerStartupMode({ dbPathExplicit: false, projectRoot: dir })).toBe('normal');
  });

  it('4: a full-width colon does not match the marker', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'aegis：導入済み\n');
    expect(detectInstallMarker(dir).claudeMdMarker).toBe(false);
    expect(resolveServerStartupMode({ dbPathExplicit: false, projectRoot: dir })).toBe('dormant');
  });

  it('5: CLAUDE.md as a directory does not throw', () => {
    mkdirSync(join(dir, 'CLAUDE.md'));
    expect(() => detectInstallMarker(dir)).not.toThrow();
    expect(detectInstallMarker(dir).claudeMdMarker).toBe(false);
  });

  it('6: .aegis directory is normal', () => {
    mkdirSync(join(dir, '.aegis'));
    expect(detectInstallMarker(dir).aegisDirExists).toBe(true);
    expect(resolveServerStartupMode({ dbPathExplicit: false, projectRoot: dir })).toBe('normal');
  });

  it('7: .aegis as a regular file is also normal', () => {
    writeFileSync(join(dir, '.aegis'), '');
    expect(detectInstallMarker(dir).aegisDirExists).toBe(true);
    expect(resolveServerStartupMode({ dbPathExplicit: false, projectRoot: dir })).toBe('normal');
  });

  it('8: an explicit --db is always normal', () => {
    expect(resolveServerStartupMode({ dbPathExplicit: true, projectRoot: dir })).toBe('normal');
  });

  it('9: .claude/CLAUDE.md is not read', () => {
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'CLAUDE.md'), 'aegis: 導入済み\n');
    expect(detectInstallMarker(dir).claudeMdMarker).toBe(false);
    expect(resolveServerStartupMode({ dbPathExplicit: false, projectRoot: dir })).toBe('dormant');
  });

  it('10: the dormant startup message is a single line with the key phrases', () => {
    const m = formatDormantStartupMessage('/x');
    expect(m).not.toContain('\n');
    expect(m).toContain('Dormant mode');
    expect(m).toContain('/x');
    expect(m).toContain('aegis: 導入済み');
    expect(m).toContain('restart the MCP server');
  });

  it('11: constants have the fixed values', () => {
    expect(INSTALL_MARKER_TEXT).toBe('aegis: 導入済み');
    expect(DEFAULT_DB_DIR).toBe('.aegis');
  });
});
