import type { Repository } from '../store/repository.js';
import type { EdgeListItem, ResolvedEdge } from '../types.js';
import type { ContextCompiler } from './compiler.js';

export const EDGES_OUTPUT_SCHEMA_VERSION = 1 as const;
export const RESOLVE_OUTPUT_SCHEMA_VERSION = 1 as const;

export interface EdgesOutput {
  schema_version: typeof EDGES_OUTPUT_SCHEMA_VERSION;
  knowledge_version: number;
  edges: EdgeListItem[];
}

export interface ResolveTarget {
  path: string;
  normalized_path: string;
}

export interface ResolvedPathDocument {
  doc_id: string;
  source_path: string | null;
  resolution_path: ResolvedEdge[];
}

export interface ResolvedPathResult {
  path: string;
  normalized_path: string;
  documents: ResolvedPathDocument[];
  resolution_path: ResolvedEdge[];
}

export interface ResolveOutput {
  schema_version: typeof RESOLVE_OUTPUT_SCHEMA_VERSION;
  knowledge_version: number;
  results: ResolvedPathResult[];
}

/** Approved edges for CLI `edges --json`. */
export function buildEdgesOutput(repo: Repository): EdgesOutput {
  return {
    schema_version: EDGES_OUTPUT_SCHEMA_VERSION,
    knowledge_version: repo.getKnowledgeMeta().current_version,
    edges: repo.listApprovedEdgesWithSourcePath(),
  };
}

function resolveOneTarget(compiler: ContextCompiler, target: ResolveTarget): ResolvedPathResult {
  const routing = compiler.routeBase({ target_files: [target.normalized_path] });
  const documents = routing.sortedDocs
    .filter((d) => d.kind !== 'template')
    .map((d) => ({
      doc_id: d.doc_id,
      source_path: d.source_path ?? null,
      resolution_path: routing.resolutionPath.filter((e) => e.target_doc_id === d.doc_id),
    }));
  return {
    path: target.path,
    normalized_path: target.normalized_path,
    documents,
    resolution_path: routing.resolutionPath,
  };
}

/** Per-path base routing for CLI `resolve`; same documents, order and resolution_path as compile_context with that single path. */
export function buildResolveOutput(
  repo: Repository,
  compiler: ContextCompiler,
  targets: ResolveTarget[],
): ResolveOutput {
  const initialized = repo.getCurrentSnapshot() !== undefined;
  const results = targets.map((t) =>
    initialized
      ? resolveOneTarget(compiler, t)
      : { path: t.path, normalized_path: t.normalized_path, documents: [], resolution_path: [] },
  );
  return {
    schema_version: RESOLVE_OUTPUT_SCHEMA_VERSION,
    knowledge_version: repo.getKnowledgeMeta().current_version,
    results,
  };
}
