import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuleBasedAnalyzer } from '../core/automation/rule-analyzer.js';
import { DORMANT_WORKSPACE_STATUS_NOTICE } from '../core/init/install-marker.js';
import { createInMemoryDatabase, Repository } from '../core/store/index.js';
import { createAegisServer, createDormantAegisServer } from './server.js';
import {
  AegisService,
  isOperationAllowedOnSurface,
  isSurface,
  SURFACES,
  type Surface,
  type SurfaceGatedOperation,
  SurfaceViolationError,
} from './services.js';

const TEMPLATES_ROOT = join(import.meta.dirname, '../../templates');

// Expected tool names are written as literals (not derived from the implementation)
// so that a registration mistake is detected.
const AGENT_TOOLS = [
  'aegis_compile_context',
  'aegis_observe',
  'aegis_get_compile_audit',
  'aegis_get_known_tags',
  'aegis_workspace_status',
  'aegis_init_detect',
];

const SSA_EXTRA_TOOLS = [
  'aegis_list_proposals',
  'aegis_get_proposal',
  'aegis_approve_proposal',
  'aegis_archive_observations',
  'aegis_get_stats',
  'aegis_process_observations',
  'aegis_sync_docs',
];

const ADMIN_ONLY_TOOLS = [
  'aegis_preflight_proposal_bundle',
  'aegis_approve_proposal_bundle',
  'aegis_reject_proposal',
  'aegis_init_confirm',
  'aegis_check_upgrade',
  'aegis_apply_upgrade',
  'aegis_import_doc',
  'aegis_analyze_doc',
  'aegis_analyze_import_batch',
  'aegis_execute_import_plan',
  'aegis_list_observations',
];

const EXPECTED_TOOLS: Record<Surface, string[]> = {
  agent: [...AGENT_TOOLS].sort(),
  ssa: [...AGENT_TOOLS, ...SSA_EXTRA_TOOLS].sort(),
  admin: [...AGENT_TOOLS, ...SSA_EXTRA_TOOLS, ...ADMIN_ONLY_TOOLS].sort(),
};

const EXPECTED_COUNTS: Record<Surface, number> = { agent: 6, ssa: 13, admin: 24 };

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function insertPendingBootstrap(repo: Repository, proposalId: string): void {
  repo.insertProposal({
    proposal_id: proposalId,
    proposal_type: 'bootstrap',
    payload: JSON.stringify({
      documents: [
        { doc_id: 'base-doc', title: 'Base', kind: 'guideline', content: 'base', content_hash: hash('base') },
      ],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'base-doc',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 0,
        },
      ],
      layer_rules: [],
    }),
    status: 'pending',
    review_comment: null,
  });
}

async function connect(
  service: AegisService,
  surface: Surface,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createAegisServer(service, surface);
  const client = new Client({ name: `test-client-${surface}`, version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function connectDormant(
  service: AegisService,
  surface: Surface,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createDormantAegisServer(service, surface);
  const client = new Client({ name: `test-client-dormant-${surface}`, version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

let projectRoot: string;
let repo: Repository;
let service: AegisService;

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'aegis-ssa-'));
  const db = await createInMemoryDatabase();
  repo = new Repository(db);
  service = new AegisService(repo, TEMPLATES_ROOT, null, [], false, projectRoot);
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('V-5: surface type guard', () => {
  it('accepts the three valid surface names', () => {
    expect(isSurface('agent')).toBe(true);
    expect(isSurface('ssa')).toBe(true);
    expect(isSurface('admin')).toBe(true);
  });

  it('rejects wrong case, empty, unknown, and undefined values', () => {
    expect(isSurface('SSA')).toBe(false);
    expect(isSurface('Admin')).toBe(false);
    expect(isSurface('')).toBe(false);
    expect(isSurface('foo')).toBe(false);
    expect(isSurface(undefined)).toBe(false);
  });

  it('lists the surfaces in order', () => {
    expect([...SURFACES]).toEqual(['agent', 'ssa', 'admin']);
  });
});

describe('V-1: tools/list per surface', () => {
  for (const surface of ['agent', 'ssa', 'admin'] as const) {
    it(`registers the expected tools on the ${surface} surface`, async () => {
      const { client, close } = await connect(service, surface);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name).sort();
        expect(names).toHaveLength(EXPECTED_COUNTS[surface]);
        expect(names).toEqual(EXPECTED_TOOLS[surface]);
      } finally {
        await close();
      }
    });
  }
});

describe('V-2: ssa tools behave the same as admin', () => {
  it('serves the review tools on ssa with the same results as admin', async () => {
    insertPendingBootstrap(repo, 'boot-ssa');
    const ssa = await connect(service, 'ssa');
    const admin = await connect(service, 'admin');
    try {
      const listSsa = await ssa.client.callTool({ name: 'aegis_list_proposals', arguments: {} });
      const listAdmin = await admin.client.callTool({ name: 'aegis_list_proposals', arguments: {} });
      expect(listSsa.isError).not.toBe(true);
      expect(listSsa.content).toEqual(listAdmin.content);

      const getSsa = await ssa.client.callTool({ name: 'aegis_get_proposal', arguments: { proposal_id: 'boot-ssa' } });
      const getAdmin = await admin.client.callTool({
        name: 'aegis_get_proposal',
        arguments: { proposal_id: 'boot-ssa' },
      });
      expect(getSsa.isError).not.toBe(true);
      expect(getSsa.content).toEqual(getAdmin.content);

      const stats = await ssa.client.callTool({ name: 'aegis_get_stats', arguments: {} });
      expect(stats.isError).not.toBe(true);
      const parsed = JSON.parse(textOf(stats));
      expect(parsed).toHaveProperty('knowledge');
      expect(parsed).toHaveProperty('usage');
      expect(parsed).toHaveProperty('health');

      for (const name of ['aegis_archive_observations', 'aegis_process_observations', 'aegis_sync_docs']) {
        const r = await ssa.client.callTool({ name, arguments: {} });
        expect(r.isError, name).not.toBe(true);
        expect(textOf(r), name).not.toContain('not available on the');
      }

      const approve = await ssa.client.callTool({
        name: 'aegis_approve_proposal',
        arguments: { proposal_id: 'boot-ssa' },
      });
      expect(approve.isError).not.toBe(true);
      expect(repo.getProposal('boot-ssa')?.status).toBe('approved');

      expect(ssa.client.getServerVersion()?.name).toBe('aegis-ssa');
    } finally {
      await ssa.close();
      await admin.close();
    }
  });
});

describe('V-3: admin-only tools are not found on ssa', () => {
  it('rejects every admin-only tool as not found', async () => {
    const { client, close } = await connect(service, 'ssa');
    try {
      for (const name of ADMIN_ONLY_TOOLS) {
        const r = await client.callTool({ name, arguments: {} });
        expect(r.isError, name).toBe(true);
        expect(textOf(r), name).toContain(`Tool ${name} not found`);
      }
    } finally {
      await close();
    }
  });
});

// Expected permissions are written as literals (not derived from SSA_ALLOWED_OPERATIONS).
const OPERATION_EXPECTATIONS: Record<SurfaceGatedOperation, { agent: boolean; ssa: boolean; admin: boolean }> = {
  aegis_list_proposals: { agent: false, ssa: true, admin: true },
  aegis_get_proposal: { agent: false, ssa: true, admin: true },
  aegis_approve_proposal: { agent: false, ssa: true, admin: true },
  aegis_archive_observations: { agent: false, ssa: true, admin: true },
  aegis_get_stats: { agent: false, ssa: true, admin: true },
  aegis_sync_docs: { agent: false, ssa: true, admin: true },
  aegis_process_observations: { agent: false, ssa: true, admin: true },
  analyzeAndPropose: { agent: false, ssa: true, admin: true },
  aegis_preflight_proposal_bundle: { agent: false, ssa: false, admin: true },
  aegis_approve_proposal_bundle: { agent: false, ssa: false, admin: true },
  aegis_approve_pending: { agent: false, ssa: false, admin: true },
  aegis_staleness_ack: { agent: false, ssa: false, admin: true },
  aegis_reject_proposal: { agent: false, ssa: false, admin: true },
  aegis_init_confirm: { agent: false, ssa: false, admin: true },
  aegis_check_upgrade: { agent: false, ssa: false, admin: true },
  aegis_apply_upgrade: { agent: false, ssa: false, admin: true },
  aegis_maintenance: { agent: false, ssa: false, admin: true },
  aegis_list_observations: { agent: false, ssa: false, admin: true },
  aegis_import_doc: { agent: false, ssa: false, admin: true },
  aegis_analyze_doc: { agent: false, ssa: false, admin: true },
  aegis_analyze_import_batch: { agent: false, ssa: false, admin: true },
  aegis_execute_import_plan: { agent: false, ssa: false, admin: true },
};

describe('V-4: service-layer surface gating', () => {
  it('(a) isOperationAllowedOnSurface matches the expected table', () => {
    expect(Object.keys(OPERATION_EXPECTATIONS)).toHaveLength(22);
    for (const [operation, expected] of Object.entries(OPERATION_EXPECTATIONS)) {
      for (const surface of ['agent', 'ssa', 'admin'] as const) {
        expect(
          isOperationAllowedOnSurface(operation as SurfaceGatedOperation, surface),
          `${operation} on ${surface}`,
        ).toBe(expected[surface]);
      }
    }
  });

  it('(b) rejects the 14 non-ssa methods on the ssa surface', async () => {
    const violation = (call: () => unknown) => expect(call).toThrow(SurfaceViolationError);
    violation(() => service.analyzeDoc({ content: '## A\n\nb' }, 'ssa'));
    violation(() => service.analyzeImportBatch({ items: [{ content: '## A\n\nb' }] }, 'ssa'));
    violation(() => service.executeImportPlan({ import_plan: { bad: true } }, 'ssa'));
    violation(() => service.applyUpgrade('ssa'));
    violation(() => service.checkUpgrade('ssa'));
    violation(() => service.initConfirm('x', 'ssa'));
    violation(() => service.rejectProposal('x', 'r', 'ssa'));
    violation(() => service.preflightProposalBundle('x', 'ssa'));
    violation(() => service.approveProposalBundle('x', 'ssa'));
    violation(() => service.listObservations({}, 'ssa'));
    violation(() => service.approvePending({ dryRun: true, types: null }, 'ssa'));
    violation(() => service.ackStaleness({ docIds: null, dryRun: true }, 'ssa'));
    await expect(
      service.importDoc({ content: '# x', doc_id: 'x', title: 'x', kind: 'guideline' }, 'ssa'),
    ).rejects.toThrow(SurfaceViolationError);
    await expect(service.runMaintenance('ssa', { dryRun: true })).rejects.toThrow(SurfaceViolationError);

    expect(() => service.rejectProposal('x', 'r', 'ssa')).toThrow(
      "Tool 'aegis_reject_proposal' is not available on the 'ssa' surface",
    );
  });

  it('(c) allows the 8 ssa methods on the ssa surface', async () => {
    insertPendingBootstrap(repo, 'boot-v4');
    expect(() => service.listProposals({}, 'ssa')).not.toThrow();
    expect(service.getProposal('missing', 'ssa')).toBeUndefined();
    expect(() => service.approveProposal('boot-v4', undefined, 'ssa')).not.toThrow();
    expect(repo.getProposal('boot-v4')?.status).toBe('approved');
    expect(() => service.archiveObservations(90, 'ssa')).not.toThrow();
    expect(() => service.getStats('ssa')).not.toThrow();
    await expect(service.syncDocs({}, 'ssa')).resolves.toBeDefined();
    await expect(service.processObservations(undefined, 'ssa')).resolves.toBeDefined();
    await expect(service.analyzeAndPropose(new RuleBasedAnalyzer(), 'compile_miss', 'ssa')).resolves.toBeDefined();
  });

  it('(d) rejects the 8 ssa methods on the agent surface', async () => {
    expect(() => service.listProposals({}, 'agent')).toThrow(SurfaceViolationError);
    expect(() => service.getProposal('missing', 'agent')).toThrow(SurfaceViolationError);
    expect(() => service.approveProposal('x', undefined, 'agent')).toThrow(SurfaceViolationError);
    expect(() => service.archiveObservations(90, 'agent')).toThrow(SurfaceViolationError);
    expect(() => service.getStats('agent')).toThrow(SurfaceViolationError);
    await expect(service.syncDocs({}, 'agent')).rejects.toThrow(SurfaceViolationError);
    await expect(service.processObservations(undefined, 'agent')).rejects.toThrow(SurfaceViolationError);
    await expect(service.analyzeAndPropose(new RuleBasedAnalyzer(), 'compile_miss', 'agent')).rejects.toThrow(
      SurfaceViolationError,
    );
  });
});

describe('dormant mode server', () => {
  it.each(SURFACES)('lists exactly 2 tools on %s', async (surface) => {
    const { client, close } = await connectDormant(service, surface);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(['aegis_init_detect', 'aegis_workspace_status']);
    } finally {
      await close();
    }
  });

  it.each(SURFACES)('reports server name aegis-%s', async (surface) => {
    const { client, close } = await connectDormant(service, surface);
    try {
      expect(client.getServerVersion()?.name).toBe(`aegis-${surface}`);
    } finally {
      await close();
    }
  });

  it('does not advertise the resources capability', async () => {
    const { client, close } = await connectDormant(service, 'agent');
    try {
      expect(client.getServerCapabilities()?.resources).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('puts the dormant notice before the workspace status JSON', async () => {
    const { client, close } = await connectDormant(service, 'agent');
    try {
      const result = await client.callTool({ name: 'aegis_workspace_status', arguments: {} });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(2);
      expect(content[0].text).toBe(DORMANT_WORKSPACE_STATUS_NOTICE);
      expect(JSON.parse(content[1].text)).toMatchObject({ pending_proposal_count: 0, active_regions: [] });
    } finally {
      await close();
    }
  });

  it('does not add the dormant notice to workspace_status on the normal server', async () => {
    const { client, close } = await connect(service, 'agent');
    try {
      const result = await client.callTool({ name: 'aegis_workspace_status', arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      expect(() => JSON.parse(content[0].text)).not.toThrow();
      expect(content[0].text).not.toContain(DORMANT_WORKSPACE_STATUS_NOTICE);
    } finally {
      await close();
    }
  });

  it('serves aegis_init_detect in dormant mode', async () => {
    const { client, close } = await connectDormant(service, 'agent');
    try {
      const result = await client.callTool({ name: 'aegis_init_detect', arguments: { project_root: projectRoot } });
      expect(result.isError).not.toBe(true);
    } finally {
      await close();
    }
  });
});
