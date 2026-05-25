import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKexpMcpServer } from './server.js';

async function createConnectedClientServer() {
  const server = createKexpMcpServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { server, client, clientTransport, serverTransport };
}

test('list tool schemas enforce 1-50 limits for shows and shows-by-host', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();

  try {
    const tools = await client.listTools();
    const showsTool = tools.tools.find((tool) => tool.name === 'kexp_list_shows');
    const showsByHostTool = tools.tools.find((tool) => tool.name === 'kexp_list_shows_by_host');

    assert.ok(showsTool, 'Expected kexp_list_shows to be registered');
    assert.ok(showsByHostTool, 'Expected kexp_list_shows_by_host to be registered');

    const showsLimitSchema = (showsTool.inputSchema.properties as Record<string, { maximum?: number } | undefined>).limit;
    assert.ok(showsLimitSchema, 'Expected kexp_list_shows.limit schema');
    assert.equal(showsLimitSchema.maximum, 50);

    const showsByHostProps = showsByHostTool.inputSchema.properties as Record<string, { maximum?: number; minimum?: number } | undefined>;
    assert.ok(showsByHostProps.limit, 'Expected kexp_list_shows_by_host.limit schema');
    assert.ok(showsByHostProps.offset, 'Expected kexp_list_shows_by_host.offset schema');
    assert.equal(showsByHostProps.limit.maximum, 50);
    assert.equal(showsByHostProps.offset.minimum, 0);
  } finally {
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});

test('kexp_list_shows_by_host returns paginated response fields', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = input instanceof URL
      ? input
      : new URL(typeof input === 'string' ? input : input.url);

    if (url.pathname === '/v2/hosts/') {
      return new Response(JSON.stringify({
        results: [{ id: 1, name: 'Kevin Cole' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/v2/shows/' && url.searchParams.get('offset') === '0') {
      return new Response(JSON.stringify({
        next: 'https://api.kexp.org/v2/shows/?offset=200&limit=200',
        results: [
          { id: 11, hosts: [1] },
          { id: 12, hosts: [2] },
          { id: 13, hosts: [1] },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/v2/shows/' && url.searchParams.get('offset') === '200') {
      return new Response(JSON.stringify({
        next: null,
        results: [
          { id: 14, hosts: [1] },
          { id: 15, hosts: [3] },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  };

  try {
    const result = await client.callTool({
      name: 'kexp_list_shows_by_host',
      arguments: {
        host_name: 'kevin',
        limit: 2,
        offset: 1,
      },
    }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };

    assert.equal(result.isError, undefined);

    const textContent = result.content.find((item: { type: string; text?: string }) => item.type === 'text');
    assert.ok(textContent, 'Expected text content from tool response');
    const textPayload = textContent.text;
    if (typeof textPayload !== 'string') {
      throw new Error('Expected text payload to be a string.');
    }

    const parsed = JSON.parse(textPayload) as {
      host: { id: number; name: string };
      total_count: number;
      limit: number;
      offset: number;
      next_offset: number | null;
      previous_offset: number | null;
      shows: Array<{ id: number }>;
    };

    assert.deepEqual(parsed.host, { id: 1, name: 'Kevin Cole' });
    assert.equal(parsed.total_count, 3);
    assert.equal(parsed.limit, 2);
    assert.equal(parsed.offset, 1);
    assert.equal(parsed.next_offset, null);
    assert.equal(parsed.previous_offset, 0);
    assert.deepEqual(parsed.shows.map((show) => show.id), [13, 14]);
  } finally {
    globalThis.fetch = originalFetch;
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});

test('tool responses escape U+2028 and U+2029 in outbound text payloads', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(JSON.stringify({
    count: 1,
    next: null,
    previous: null,
    results: [{ id: 42, name: 'DJ\u2028Line\u2029Para' }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const result = await client.callTool({
      name: 'kexp_list_hosts',
      arguments: {},
    }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };

    assert.equal(result.isError, undefined);
    const text = result.content.find((item) => item.type === 'text')?.text ?? '';
    assert.ok(!text.includes('\u2028'), 'U+2028 must not appear raw in outbound payload');
    assert.ok(!text.includes('\u2029'), 'U+2029 must not appear raw in outbound payload');
    assert.ok(text.includes('\\u2028'), 'U+2028 must be escaped in outbound payload');
    assert.ok(text.includes('\\u2029'), 'U+2029 must be escaped in outbound payload');
  } finally {
    globalThis.fetch = originalFetch;
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});

test('shows tools reject limit values above 50', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();

  try {
    const showsResult = await client.callTool({
      name: 'kexp_list_shows',
      arguments: { limit: 51 },
    }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };

    assert.equal(showsResult.isError, true);
    const showsText = showsResult.content.find((item) => item.type === 'text')?.text ?? '';
    assert.match(showsText, /limit|1 and 50|between/i);

    const showsByHostResult = await client.callTool({
      name: 'kexp_list_shows_by_host',
      arguments: { host_id: 1, limit: 51 },
    }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };

    assert.equal(showsByHostResult.isError, true);
    const showsByHostText = showsByHostResult.content.find((item) => item.type === 'text')?.text ?? '';
    assert.match(showsByHostText, /limit|1 and 50|between/i);
  } finally {
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});