/**
 * Install Marker
 * Decides the MCP server startup mode (normal / dormant) from install markers in the project root.
 * Pure filesystem inspection: writes nothing and prints nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Directory that holds the default DB (`<project-root>/.aegis/aegis.db`). Moved here from src/main.ts. */
export const DEFAULT_DB_DIR = '.aegis';

/** File in the project root that may carry the install marker line. */
export const CLAUDE_MD_FILE = 'CLAUDE.md';

/** Install marker text. A CLAUDE.md containing this text (anywhere in a line) marks Aegis as installed. */
export const INSTALL_MARKER_TEXT = 'aegis: 導入済み';

/** Result of inspecting the project root for install markers. */
export interface InstallMarkerState {
  /** `<project-root>/CLAUDE.md` is readable and contains INSTALL_MARKER_TEXT. */
  readonly claudeMdMarker: boolean;
  /** `<project-root>/.aegis` exists (directory or any other file type). */
  readonly aegisDirExists: boolean;
}

/** `normal`: open the file DB and register the surface's tools. `dormant`: in-memory DB, 2 tools, no files. */
export type ServerStartupMode = 'normal' | 'dormant';

/**
 * Inspect `<projectRoot>/CLAUDE.md` and `<projectRoot>/.aegis`. Never throws:
 * any error while reading CLAUDE.md (ENOENT, EISDIR, EACCES, ...) yields `claudeMdMarker: false`.
 * Only `<projectRoot>/CLAUDE.md` is read (not `.claude/CLAUDE.md`, subdirectories, or `~/.claude/CLAUDE.md`).
 */
export function detectInstallMarker(projectRoot: string): InstallMarkerState {
  let claudeMdMarker: boolean;
  try {
    claudeMdMarker = readFileSync(join(projectRoot, CLAUDE_MD_FILE), 'utf-8').includes(INSTALL_MARKER_TEXT);
  } catch {
    claudeMdMarker = false;
  }
  const aegisDirExists = existsSync(join(projectRoot, DEFAULT_DB_DIR));
  return { claudeMdMarker, aegisDirExists };
}

/**
 * Decide the MCP server startup mode. Called once at startup.
 * - `dbPathExplicit === true` → `'normal'` without inspecting the project root.
 * - otherwise → `'normal'` if `claudeMdMarker || aegisDirExists`, else `'dormant'`.
 */
export function resolveServerStartupMode(input: { dbPathExplicit: boolean; projectRoot: string }): ServerStartupMode {
  if (input.dbPathExplicit) {
    return 'normal';
  }
  const state = detectInstallMarker(input.projectRoot);
  return state.claudeMdMarker || state.aegisDirExists ? 'normal' : 'dormant';
}

/** The single stderr line printed in dormant mode (no trailing newline; contains no '\n'). */
export function formatDormantStartupMessage(projectRoot: string): string {
  return (
    `[aegis] Dormant mode: Aegis is not installed in ${projectRoot} ` +
    `(no line containing "${INSTALL_MARKER_TEXT}" in CLAUDE.md and no .aegis/). ` +
    'Only aegis_init_detect and aegis_workspace_status are available and nothing is written to disk. ' +
    `To install, add a line containing "${INSTALL_MARKER_TEXT}" to CLAUDE.md or create .aegis/, ` +
    'then restart the MCP server.'
  );
}

/** The sentence placed in `content[0]` of `aegis_workspace_status` in dormant mode. */
export const DORMANT_WORKSPACE_STATUS_NOTICE: string =
  'Aegis is in dormant mode: it is not installed in this project ' +
  `(no line containing "${INSTALL_MARKER_TEXT}" in CLAUDE.md and no .aegis/), ` +
  'so the database is empty and in-memory. ' +
  `To install, add a line containing "${INSTALL_MARKER_TEXT}" to the project's CLAUDE.md or create .aegis/, ` +
  'then reconnect the MCP server.';
