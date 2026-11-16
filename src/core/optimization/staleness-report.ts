/**
 * Reports Level-3 semantic staleness findings with commit-range attribution (CLI `staleness-report`).
 *
 * A finding on path `p` is *attributable* to the range `base..head` when the baseline fingerprint of `p` equals
 * the fingerprint of `p` at `base`, and the fingerprint the scan saw for `p` equals the fingerprint of `p` at
 * `head` (the working tree when no head ref is given). Absent on both sides counts as equal. An attributable
 * finding is explained entirely by the changes in that range, so an agent that reviewed the range's diff against
 * the document can acknowledge it; a finding that is not attributable comes from changes the range does not
 * show (an earlier unacknowledged commit, uncommitted edits, a routing edge change) and needs a human look.
 *
 * Blobs are read with `git cat-file --filters` so they are compared in their working-tree form (eol, LFS).
 * Read-only: no baseline or observation is written.
 */

import { execFileSync } from 'node:child_process';
import type { Repository } from '../store/repository.js';
import type { Document } from '../types.js';
import {
  collectSemanticStalenessFindings,
  docSourcePathSet,
  fingerprintBytes,
  fingerprintLinkedFile,
} from './staleness.js';

export interface StalenessReportOptions {
  /** Approved doc_ids to report on, or null for every approved document. */
  docIds: readonly string[] | null;
  /** Commit-ish the baselines are expected to match. */
  baseRef: string;
  /** Commit-ish the scanned files are expected to match, or null for the working tree. */
  headRef: string | null;
}

export interface StalenessReportFinding {
  kind: string;
  path: string;
  detail: string;
  attributable: boolean;
}

export interface StalenessReportDocument {
  doc_id: string;
  source_path: string | null;
  ownership: string;
  findings: StalenessReportFinding[];
  /** True when every Level-3 finding of the document is attributable to the range. */
  all_attributable: boolean;
}

export interface StalenessReport {
  /** Resolved full commit SHA of the base ref. */
  base_ref: string;
  /** Resolved full commit SHA of the head ref, or null when the working tree is the head. */
  head_ref: string | null;
  /** Documents with at least one Level-3 finding, in approved-document order. */
  documents: StalenessReportDocument[];
}

/** Approved documents named by docIds (deduplicated, in the given order), or all of them for null. */
export function selectApprovedDocs(approved: Document[], docIds: readonly string[] | null): Document[] {
  if (docIds === null) return approved;
  const byId = new Map(approved.map((d) => [d.doc_id, d]));
  const unknown = docIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`not approved documents: ${unknown.join(', ')}`);
  }
  return [...new Set(docIds)].map((id) => byId.get(id) as Document);
}

/** Full SHA of the commit a ref names; throws when it names none. */
export function resolveCommit(projectRoot: string, ref: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(`'${ref}' does not name a commit in ${projectRoot}`);
  }
}

/** Fingerprints of `<commit>:<path>` blobs in their working-tree form; a path absent at the commit is null. */
class CommitFingerprints {
  private readonly cache = new Map<string, string | null>();

  constructor(
    private readonly projectRoot: string,
    private readonly commit: string,
  ) {}

  get(relPosix: string): string | null {
    const cached = this.cache.get(relPosix);
    if (cached !== undefined) return cached;
    let fp: string | null;
    try {
      // `./` makes the path relative to cwd (the project root), which may sit below the git top level.
      const body = execFileSync('git', ['cat-file', '--filters', `${this.commit}:./${relPosix}`], {
        cwd: this.projectRoot,
        maxBuffer: 1024 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      fp = fingerprintBytes(relPosix, body);
    } catch {
      fp = null;
    }
    this.cache.set(relPosix, fp);
    return fp;
  }
}

function parseBaseline(json: string | null): Record<string, string> {
  if (json === null || json === '') return {};
  try {
    return JSON.parse(json) as Record<string, string>;
  } catch {
    return {};
  }
}

export function buildStalenessReport(
  repo: Repository,
  projectRoot: string,
  options: StalenessReportOptions,
): StalenessReport {
  const approved = repo.getApprovedDocuments();
  const docs = selectApprovedDocs(approved, options.docIds);
  const baseCommit = resolveCommit(projectRoot, options.baseRef);
  const headCommit = options.headRef === null ? null : resolveCommit(projectRoot, options.headRef);

  const scan = collectSemanticStalenessFindings({
    docs,
    edges: repo.getApprovedEdges(),
    projectRoot,
    getBaseline: (id) => repo.getStalenessBaseline(id),
    persistLevel3Baselines: false,
    excludedLinkedPaths: docSourcePathSet(approved),
  });

  const base = new CommitFingerprints(projectRoot, baseCommit);
  const head = headCommit === null ? null : new CommitFingerprints(projectRoot, headCommit);
  const workingTree = new Map<string, string | null>();
  const current = (p: string): string | null => {
    if (!workingTree.has(p)) workingTree.set(p, fingerprintLinkedFile(projectRoot, p));
    return workingTree.get(p) ?? null;
  };

  const byDoc = new Map<string, StalenessReportFinding[]>();
  for (const f of scan.findings) {
    if (f.level !== 3) continue;
    const path = f.paths?.[0];
    if (path === undefined) continue;
    const baselineFp =
      f.kind === 'linked_file_added' ? null : (parseBaseline(repo.getStalenessBaseline(f.doc_id))[path] ?? null);
    const scannedFp = f.kind === 'linked_file_removed' ? null : current(path);
    const headFp = head === null ? current(path) : head.get(path);
    const attributable = baselineFp === base.get(path) && scannedFp === headFp;
    const list = byDoc.get(f.doc_id) ?? [];
    list.push({ kind: f.kind, path, detail: f.detail, attributable });
    byDoc.set(f.doc_id, list);
  }

  const documents: StalenessReportDocument[] = [];
  for (const doc of docs) {
    const findings = byDoc.get(doc.doc_id);
    if (findings === undefined) continue;
    documents.push({
      doc_id: doc.doc_id,
      source_path: doc.source_path,
      ownership: doc.ownership,
      findings,
      all_attributable: findings.every((f) => f.attributable),
    });
  }
  return { base_ref: baseCommit, head_ref: headCommit, documents };
}
