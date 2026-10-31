/**
 * ADR-015 Task 015-07: deterministic semantic staleness (Levels 1–3).
 *
 * Level 1: file-anchored `source_path` content hash ≠ canonical `content_hash`
 * Level 2: `source_path` missing, or rename candidate (same content hash elsewhere)
 * Level 3: path_edges → linked files: TypeScript symbol set or non-TS file hash drift
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import picomatch from 'picomatch';
import { resolveSourcePath } from '../paths.js';
import { parseSourceRefsJson, sourceRefCountFromDocument } from '../source-refs.js';
import type { Document, Edge, StalenessDetectedPayload } from '../types.js';
import { listRepoFiles, type RepoListingSource } from './repo-file-listing.js';

export { listRepoRelativeFiles } from './repo-file-listing.js';

export const SEMANTIC_STALENESS_ALGORITHM_VERSION = '015-10-3' as const;

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Deterministic exported surface for TypeScript-like sources: only identifiers that are definitely
 * exported from this module (named export list, export function/class/const/interface/type, default
 * export with a name). Intentionally excludes non-exported top-level declarations.
 */
export function extractTsExportedSymbols(source: string): string[] {
  const names = new Set<string>();
  const lines = source.split('\n');
  for (const raw of lines) {
    const line = raw.trimStart();
    if (!/\bexport\b/.test(line)) continue;

    const block = line.match(/\bexport\s*\{([^}]+)\}/);
    if (block) {
      for (const part of block[1]!.split(',')) {
        const head = part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim()
          .split(/\s+/)[0];
        if (head && /^\w+$/.test(head)) names.add(head);
      }
      continue;
    }

    let m = line.match(/\bexport\s+default\s+(?:abstract\s+)?class\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }
    m = line.match(/\bexport\s+default\s+(?:async\s+)?function\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }

    m = line.match(/\bexport\s+(?:async\s+)?function\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }
    m = line.match(/\bexport\s+class\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }
    m = line.match(/\bexport\s+(?:const|let|var)\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }
    m = line.match(/\bexport\s+interface\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }
    m = line.match(/\bexport\s+type\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }
    m = line.match(/\bexport\s+namespace\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function isTsLike(relPosix: string): boolean {
  const lower = relPosix.toLowerCase();
  return lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts');
}

function fingerprintLinkedFile(projectRoot: string, relPosix: string): string | null {
  let absPath: string;
  try {
    absPath = resolveSourcePath(relPosix, projectRoot);
  } catch {
    return null;
  }
  if (!existsSync(absPath)) return null;
  try {
    const body = readFileSync(absPath);
    if (isTsLike(relPosix)) {
      const txt = body.toString('utf-8');
      const syms = extractTsExportedSymbols(txt);
      const joined = syms.join('\n');
      return `sym:${createHash('sha256').update(joined).digest('hex')}`;
    }
    return `raw:${createHash('sha256').update(body).digest('hex')}`;
  } catch {
    return null;
  }
}

/** Repo-relative posix paths declared in `source_refs_json` (dedupe + sort). */
export function linkedPathsFromSourceRefs(doc: Pick<Document, 'source_refs_json'>): string[] {
  const refs = parseSourceRefsJson(doc.source_refs_json ?? null);
  const paths = refs.map((r) => toPosix(r.asset_path.trim())).filter((p) => p.length > 0);
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

/** Multi-source Level-3 paths: refs plus legacy `source_path` when it names another distinct asset (015-10). */
export function linkedPathsForMultiSourceStaleness(doc: Pick<Document, 'source_path' | 'source_refs_json'>): string[] {
  const fromRefs = linkedPathsFromSourceRefs(doc);
  const raw = doc.source_path != null ? String(doc.source_path).trim() : '';
  if (raw === '') return fromRefs;
  return mergeSortedUniquePaths(fromRefs, [toPosix(raw)]);
}

function mergeSortedUniquePaths(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort((x, y) => x.localeCompare(y));
}

/** picomatch matchers for approved path_requires/path edges that target docId. */
export function buildEdgeMatchers(docId: string, edges: Edge[]): Array<(posixPath: string) => boolean> {
  const matchers: Array<(posixPath: string) => boolean> = [];
  for (const e of edges) {
    if (e.status !== 'approved') continue;
    if (e.target_doc_id !== docId || e.edge_type !== 'path_requires' || e.source_type !== 'path') continue;
    matchers.push(picomatch(e.source_value, { dot: true }));
  }
  return matchers;
}

/** Paths under project matching path_requires edges that target docId (approved path edges only). */
export function linkedPathsForDoc(docId: string, edges: Edge[], sortedRelFiles: string[]): string[] {
  const matchers = buildEdgeMatchers(docId, edges);
  if (matchers.length === 0) return [];
  const matched = new Set<string>();
  for (const rel of sortedRelFiles) {
    const posix = toPosix(rel);
    if (matchers.some((m) => m(posix))) matched.add(posix);
  }
  return [...matched].sort((a, b) => a.localeCompare(b));
}

/** Per-scan fingerprint cache (remembers null results too). */
export class FingerprintMemo {
  private readonly cache = new Map<string, string | null>();
  private computed = 0;

  get(relPosix: string, compute: () => string | null): string | null {
    if (this.cache.has(relPosix)) return this.cache.get(relPosix) ?? null;
    const value = compute();
    this.computed += 1;
    this.cache.set(relPosix, value);
    return value;
  }

  get computeCount(): number {
    return this.computed;
  }
}

export function fingerprintEdgeLinkedArtifacts(
  projectRoot: string,
  linkedPathsSorted: string[],
  memo?: FingerprintMemo,
): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const p of linkedPathsSorted) {
    const fp = memo ? memo.get(p, () => fingerprintLinkedFile(projectRoot, p)) : fingerprintLinkedFile(projectRoot, p);
    if (fp !== null) rec[p] = fp;
  }
  const ordered: Record<string, string> = {};
  for (const k of Object.keys(rec).sort((a, b) => a.localeCompare(b))) {
    ordered[k] = rec[k]!;
  }
  return ordered;
}

export function stableStringifyFingerprints(rec: Record<string, string>): string {
  const ordered: Record<string, string> = {};
  for (const k of Object.keys(rec).sort((a, b) => a.localeCompare(b))) {
    ordered[k] = rec[k]!;
  }
  return JSON.stringify(ordered);
}

function finding(payload: Omit<StalenessDetectedPayload, 'algorithm_version'>): StalenessDetectedPayload {
  return { ...payload, algorithm_version: SEMANTIC_STALENESS_ALGORITHM_VERSION };
}

function hashBytesUtf8(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** First path in deterministic order whose file hashes to contentHash (full-file SHA-256 as hex). */
export function findRenameCandidatePath(
  projectRoot: string,
  sortedRelFiles: string[],
  contentHash: string,
): string | undefined {
  for (const rel of sortedRelFiles) {
    const posix = toPosix(rel);
    try {
      const abs = resolveSourcePath(posix, projectRoot);
      if (!existsSync(abs)) continue;
      const txt = readFileSync(abs, 'utf-8');
      if (hashBytesUtf8(txt) === contentHash) return posix;
    } catch {}
  }
  return undefined;
}

export interface SemanticStalenessScanInput {
  docs: Document[];
  edges: Edge[];
  projectRoot: string;
  /** Level-3 baseline keyed by doc_id → JSON fingerprint map (same shape as persisted `staleness_baselines`). */
  getBaseline: (docId: string) => string | null;
  /**
   * When true, persist Level-3 fingerprints (initial baseline, refresh after no drift, repair corrupt JSON).
   * Dry-run maintenance should pass false so SQLite rows are not written.
   */
  persistLevel3Baselines: boolean;
}

export interface SemanticStalenessScanStats {
  files_listed: number;
  fingerprints_computed: number;
  listing_source: RepoListingSource;
}

export interface SemanticStalenessScanResult {
  findings: StalenessDetectedPayload[];
  baselineUpserts: Array<{ doc_id: string; fingerprint_json: string }>;
  stats: SemanticStalenessScanStats;
}

/**
 * A baseline path that is absent from the current fingerprints but still exists on disk and still matches
 * the edge globs was only dropped from the scan scope (e.g. now git-ignored), not removed.
 */
function movedOutOfScan(
  k: string,
  linkedSet: ReadonlySet<string>,
  fileSet: ReadonlySet<string>,
  matchers: Array<(posixPath: string) => boolean>,
  projectRoot: string,
): boolean {
  if (linkedSet.has(k) || fileSet.has(k)) return false;
  let exists: boolean;
  try {
    exists = existsSync(resolveSourcePath(k, projectRoot));
  } catch {
    return false;
  }
  return exists && matchers.some((m) => m(k));
}

export function collectSemanticStalenessFindings(input: SemanticStalenessScanInput): SemanticStalenessScanResult {
  const findings: StalenessDetectedPayload[] = [];
  const baselineUpserts: Array<{ doc_id: string; fingerprint_json: string }> = [];

  const listing = listRepoFiles(input.projectRoot);
  const sortedFiles = listing.files;
  const fileSet = new Set(sortedFiles);
  const memo = new FingerprintMemo();
  const edgeTargets = new Set<string>();
  for (const e of input.edges) {
    if (e.status === 'approved' && e.edge_type === 'path_requires' && e.source_type === 'path') {
      edgeTargets.add(e.target_doc_id);
    }
  }

  for (const doc of input.docs) {
    if (doc.status !== 'approved') continue;

    const isAnchored =
      doc.ownership === 'file-anchored' && typeof doc.source_path === 'string' && doc.source_path.trim().length > 0;

    /** Merged delivery units: single-file hash vs canonical is meaningless (015-10). */
    const skipLevel1HashVsCanonical = sourceRefCountFromDocument(doc) > 1;

    if (isAnchored && !skipLevel1HashVsCanonical) {
      let absPath: string | undefined;
      try {
        absPath = resolveSourcePath(doc.source_path!.trim(), input.projectRoot);
      } catch {
        absPath = undefined;
      }

      if (absPath && existsSync(absPath)) {
        let content: string;
        try {
          content = readFileSync(absPath, 'utf-8');
        } catch {
          findings.push(
            finding({
              doc_id: doc.doc_id,
              level: 2,
              kind: 'source_unreadable',
              detail: `Cannot read source_path '${doc.source_path}' for '${doc.doc_id}'.`,
              paths: [doc.source_path!.trim()],
            }),
          );
          continue;
        }
        const diskHash = hashBytesUtf8(content);
        if (diskHash !== doc.content_hash) {
          findings.push(
            finding({
              doc_id: doc.doc_id,
              level: 1,
              kind: 'hash_mismatch',
              detail: `File-anchored document '${doc.doc_id}' (${doc.title}): on-disk SHA-256 differs from canonical content_hash.`,
              paths: [toPosix(doc.source_path!.trim())],
            }),
          );
        }
      } else if (absPath) {
        findings.push(
          finding({
            doc_id: doc.doc_id,
            level: 2,
            kind: 'source_missing',
            detail: `source_path '${doc.source_path}' for '${doc.doc_id}' does not exist under project root.`,
            paths: [doc.source_path!.trim()],
          }),
        );
        const rename = findRenameCandidatePath(input.projectRoot, sortedFiles, doc.content_hash);
        if (rename !== undefined) {
          findings.push(
            finding({
              doc_id: doc.doc_id,
              level: 2,
              kind: 'rename_candidate',
              detail: `Same canonical content_hash found at '${rename}' — possible rename from '${doc.source_path}'.`,
              paths: [doc.source_path!.trim()],
              rename_candidate_path: rename,
            }),
          );
        }
      }
    }

    const multiSource = sourceRefCountFromDocument(doc) > 1;
    const pathRequiresTarget = edgeTargets.has(doc.doc_id);
    const refPathsForMulti = linkedPathsForMultiSourceStaleness(doc);
    if (!pathRequiresTarget && !(multiSource && refPathsForMulti.length > 0)) continue;

    const linked = multiSource
      ? mergeSortedUniquePaths(linkedPathsForDoc(doc.doc_id, input.edges, sortedFiles), refPathsForMulti)
      : linkedPathsForDoc(doc.doc_id, input.edges, sortedFiles);

    if (linked.length === 0) continue;
    const linkedSet = new Set(linked);
    const matchers = buildEdgeMatchers(doc.doc_id, input.edges);
    const currentMap = fingerprintEdgeLinkedArtifacts(input.projectRoot, linked, memo);
    const serialized = stableStringifyFingerprints(currentMap);

    const prev = input.getBaseline(doc.doc_id);
    if (prev === null || prev === '') {
      if (input.persistLevel3Baselines) {
        baselineUpserts.push({ doc_id: doc.doc_id, fingerprint_json: serialized });
      }
      continue;
    }

    let prevObj: Record<string, string>;
    try {
      prevObj = JSON.parse(prev) as Record<string, string>;
    } catch {
      if (input.persistLevel3Baselines) {
        baselineUpserts.push({ doc_id: doc.doc_id, fingerprint_json: serialized });
      }
      continue;
    }

    const keys = new Set([...Object.keys(prevObj), ...Object.keys(currentMap)]);
    const sortedKeys = [...keys].sort((a, b) => a.localeCompare(b));
    let drift = false;
    for (const k of sortedKeys) {
      const a = prevObj[k];
      const b = currentMap[k];
      if (a === undefined && b !== undefined) {
        drift = true;
        findings.push(
          finding({
            doc_id: doc.doc_id,
            level: 3,
            kind: 'linked_file_added',
            detail: `New linked path '${k}' matches routing edges for '${doc.doc_id}' since last baseline.`,
            paths: [k],
          }),
        );
      } else if (a !== undefined && b === undefined) {
        if (movedOutOfScan(k, linkedSet, fileSet, matchers, input.projectRoot)) continue;
        drift = true;
        findings.push(
          finding({
            doc_id: doc.doc_id,
            level: 3,
            kind: 'linked_file_removed',
            detail: `Linked path '${k}' no longer matches routing edges or file was removed for '${doc.doc_id}'.`,
            paths: [k],
          }),
        );
      } else if (a !== undefined && b !== undefined && a !== b) {
        drift = true;
        findings.push(
          finding({
            doc_id: doc.doc_id,
            level: 3,
            kind: 'symbol_drift',
            detail: `Linked artifact fingerprint changed for '${k}' (exported symbols or file bytes) affecting '${doc.doc_id}'.`,
            paths: [k],
          }),
        );
      }
    }

    if (!drift && input.persistLevel3Baselines) {
      baselineUpserts.push({ doc_id: doc.doc_id, fingerprint_json: serialized });
    }
  }

  return {
    findings,
    baselineUpserts,
    stats: {
      files_listed: sortedFiles.length,
      fingerprints_computed: memo.computeCount,
      listing_source: listing.source,
    },
  };
}
