import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDatabase, Repository } from '../core/store/index.js';
import { createAegisServer } from './server.js';
import { AegisService } from './services.js';

const TEMPLATES_ROOT = join(import.meta.dirname, '../../templates');

interface Harness {
  service: AegisService;
  client: Client;
  close: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const db = await createInMemoryDatabase();
  const repo = new Repository(db);
  const service = new AegisService(repo, TEMPLATES_ROOT);
  const server = createAegisServer(service, 'admin');
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    service,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callText(client: Client, name: string): Promise<{ isError: boolean | undefined; text: string }> {
  const response = await client.callTool({ name, arguments: {} });
  const content = response.content as Array<{ type: string; text: string }>;
  return { isError: response.isError as boolean | undefined, text: content[0].text };
}

describe('MCP tool error responses via server (US5 / FR-017)', () => {
  let harness: Harness;

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
    vi.restoreAllMocks();
  });

  describe('aegis_sync_docs', () => {
    const cases: Array<{ label: string; rejection: unknown; expected: string }> = [
      { label: 'undefined', rejection: undefined, expected: 'Sync failed: unknown error (undefined)' },
      { label: "'str'", rejection: 'str', expected: 'Sync failed: str' },
      { label: "new Error('')", rejection: new Error(''), expected: 'Sync failed: Error' },
      { label: "new Error('boom')", rejection: new Error('boom'), expected: 'Sync failed: boom' },
    ];

    for (const { label, rejection, expected } of cases) {
      it(`returns "${expected}" when syncDocs rejects with ${label}`, async () => {
        vi.spyOn(harness.service, 'syncDocs').mockRejectedValue(rejection);

        const { isError, text } = await callText(harness.client, 'aegis_sync_docs');

        expect(isError).toBe(true);
        expect(text).toBe(expected);
        expect(text).not.toBe('Sync failed: undefined');
      });
    }
  });

  describe('aegis_process_observations', () => {
    it('returns "Processing failed: unknown error (undefined)" when processObservations rejects with undefined', async () => {
      vi.spyOn(harness.service, 'processObservations').mockRejectedValue(undefined);

      const { isError, text } = await callText(harness.client, 'aegis_process_observations');

      expect(isError).toBe(true);
      expect(text).toBe('Processing failed: unknown error (undefined)');
    });
  });
});
