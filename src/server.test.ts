import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { clearInStudioEventsCache } from './kexpEventsClient.js';
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

test('kexp-about resource is listed and returns markdown contents', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();

  try {
    const resources = await client.listResources();
    const aboutResource = resources.resources.find((resource) => resource.name === 'kexp-about');

    assert.ok(aboutResource, 'Expected kexp-about resource to be registered');
    assert.equal(aboutResource.uri, 'kexp://about');
    assert.equal(aboutResource.mimeType, 'text/markdown');

    const response = await client.readResource({ uri: 'kexp://about' });
    assert.equal(response.contents.length, 1);

    const firstContent = response.contents[0];
    assert.ok(firstContent, 'Expected resource read response content');
    assert.ok('text' in firstContent, 'Expected text resource content');
    if (!('text' in firstContent)) {
      throw new Error('Expected text field in resource content.');
    }

    const expectedMarkdown = await readFile(new URL('./kexp-about.md', import.meta.url), 'utf8');
    assert.equal(firstContent.uri, 'kexp://about');
    assert.equal(firstContent.mimeType, 'text/markdown');
    assert.equal(firstContent.text, expectedMarkdown);
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

test('kexp_list_in_studio_events tool schema exposes expected pagination and date filters', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();

  try {
    const tools = await client.listTools();
    const eventsTool = tools.tools.find((tool) => tool.name === 'kexp_list_in_studio_events');
    assert.ok(eventsTool, 'Expected kexp_list_in_studio_events to be registered');

    const props = eventsTool.inputSchema.properties as Record<string, { maximum?: number; minimum?: number } | undefined>;
    assert.ok(props.limit, 'Expected kexp_list_in_studio_events.limit schema');
    assert.ok(props.offset, 'Expected kexp_list_in_studio_events.offset schema');
    assert.equal(props.limit.maximum, 50);
    assert.equal(props.limit.minimum, 1);
    assert.equal(props.offset.minimum, 0);
  } finally {
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});

test('kexp_list_in_studio_events parses in-studio events with date filtering and offsets', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();
  const originalFetch = globalThis.fetch;

  clearInStudioEventsCache();

  globalThis.fetch = async (input) => {
    const url = input instanceof URL
      ? input
      : new URL(typeof input === 'string' ? input : input.url);

    if (url.toString().startsWith('https://kexp.org/events/kexp-events/?category=in-studio')) {
      const html = `
        <html>
          <body>
            <h2>Monday, 1 June 2026</h2>
            <h5>NOON</h5>
            <h3><a href="/events/kexp-events/ladytron-live-on-kexp-kexp_485591/">Ladytron LIVE on KEXP (OPEN TO THE PUBLIC)</a></h3>
            <a href="https://maps.google.com/?q=kexp-studio-nw-rooms">KEXP Studio (NW Rooms)</a>
            <h5>PHOTO BY MARK MCNULTY</h5>
            <a href="/events/kexp-events/ladytron-live-on-kexp-kexp_485591/">MORE</a>

            <h2>Friday, 5 June 2026</h2>
            <h5>11 A.M.</h5>
            <h3><a href="/events/kexp-events/isobel-campbell-live-on-kexp-kexp_485603/">Isobel Campbell LIVE on KEXP (OPEN TO THE PUBLIC)</a></h3>
            <a href="https://maps.google.com/?q=kexp-studio-nw-rooms">KEXP Studio (NW Rooms)</a>

            <h2>Wednesday, 22 July 2026</h2>
            <h5>3 P.M.</h5>
            <h3><a href="/events/kexp-events/snooper-live-on-kexp-kexp_490865/">Snooper LIVE on KEXP</a></h3>
          </body>
        </html>
      `;

      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('Not found', { status: 404 });
  };

  try {
    const result = await client.callTool({
      name: 'kexp_list_in_studio_events',
      arguments: {
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        limit: 1,
        offset: 1,
      },
    }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };

    assert.equal(result.isError, undefined);

    const textContent = result.content.find((item) => item.type === 'text');
    assert.ok(textContent, 'Expected text content from tool response');
    const payloadText = textContent.text;
    if (typeof payloadText !== 'string') {
      throw new Error('Expected text payload to be a string.');
    }

    const parsed = JSON.parse(payloadText) as {
      total_count: number;
      limit: number;
      offset: number;
      next_offset: number | null;
      previous_offset: number | null;
      events: Array<{
        id: string;
        title: string;
        date_iso: string;
        time_text: string;
        venue: string | null;
        photo_credit: string | null;
        is_open_to_public: boolean;
      }>;
    };

    assert.equal(parsed.total_count, 2);
    assert.equal(parsed.limit, 1);
    assert.equal(parsed.offset, 1);
    assert.equal(parsed.next_offset, null);
    assert.equal(parsed.previous_offset, 0);
    assert.equal(parsed.events.length, 1);
    const firstEvent = parsed.events[0];
    assert.ok(firstEvent, 'Expected one event in paged response');
    assert.equal(firstEvent.id, 'isobel-campbell-live-on-kexp-kexp_485603');
    assert.equal(firstEvent.date_iso, '2026-06-05');
    assert.equal(firstEvent.time_text, '11 AM');
    assert.equal(firstEvent.venue, 'KEXP Studio (NW Rooms)');
    assert.equal(firstEvent.photo_credit, null);
    assert.equal(firstEvent.is_open_to_public, true);
  } finally {
    clearInStudioEventsCache();
    globalThis.fetch = originalFetch;
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});

test('kexp_list_in_studio_events rejects invalid date filters', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();

  try {
    const result = await client.callTool({
      name: 'kexp_list_in_studio_events',
      arguments: {
        start_date: '2026/06/01',
      },
    }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };

    assert.equal(result.isError, true);
    const text = result.content.find((item) => item.type === 'text')?.text ?? '';
    assert.match(text, /YYYY-MM-DD/i);
  } finally {
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});

test('new tools are all registered: kexp_now_playing, kexp_what_is_on_now, kexp_get_show_playlist, kexp_new_music, kexp_local_artist_plays', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();

  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);

    assert.ok(names.includes('kexp_now_playing'), 'Expected kexp_now_playing');
    assert.ok(names.includes('kexp_what_is_on_now'), 'Expected kexp_what_is_on_now');
    assert.ok(names.includes('kexp_get_show_playlist'), 'Expected kexp_get_show_playlist');
    assert.ok(names.includes('kexp_new_music'), 'Expected kexp_new_music');
    assert.ok(names.includes('kexp_local_artist_plays'), 'Expected kexp_local_artist_plays');
  } finally {
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});

test('kexp_list_plays schema exposes new filter fields', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();

  try {
    const tools = await client.listTools();
    const playsTool = tools.tools.find((t) => t.name === 'kexp_list_plays');
    assert.ok(playsTool, 'Expected kexp_list_plays to be registered');
    const props = playsTool.inputSchema.properties as Record<string, unknown>;
    assert.ok(props['rotation_status'], 'Expected rotation_status filter');
    assert.ok(props['is_local'], 'Expected is_local filter');
    assert.ok(props['is_request'], 'Expected is_request filter');
    assert.ok(props['is_live'], 'Expected is_live filter');
  } finally {
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});

test('kexp_now_playing combines play and show data', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);

    if (url.pathname === '/v2/plays/') {
      return new Response(JSON.stringify({
        results: [{
          id: 999,
          show: 42,
          song: 'Test Song',
          artist: 'Test Artist',
          play_type: 'trackplay',
          comment: 'A great song chosen with care.',
          is_local: false,
          is_request: true,
          is_live: false,
          rotation_status: 'Add',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/v2/shows/42/') {
      return new Response(JSON.stringify({
        id: 42,
        program_name: 'The Morning Show',
        host_names: ['Cheryl Waters'],
        tagline: 'Start your day with music',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Not found', { status: 404 });
  };

  try {
    const result = await client.callTool({
      name: 'kexp_now_playing',
      arguments: {},
    }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };

    assert.equal(result.isError, undefined);
    const text = result.content.find((item) => item.type === 'text')?.text ?? '';
    const parsed = JSON.parse(text) as { play: { song: string; show: number }; show: { program_name: string } };
    assert.equal(parsed.play.song, 'Test Song');
    assert.equal(parsed.play.show, 42);
    assert.equal(parsed.show.program_name, 'The Morning Show');
  } finally {
    globalThis.fetch = originalFetch;
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});

test('kexp_get_show_playlist passes show_ids and exclude_airbreaks to plays endpoint', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();
  const originalFetch = globalThis.fetch;
  let capturedUrl: URL | null = null;

  globalThis.fetch = async (input) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    capturedUrl = url;
    return new Response(JSON.stringify({ count: 0, next: null, previous: null, results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await client.callTool({
      name: 'kexp_get_show_playlist',
      arguments: { show_id: 66837 },
    });

    assert.ok(capturedUrl, 'Expected a fetch call to have been made');
    const resolvedUrl1 = capturedUrl as URL;
    assert.equal(resolvedUrl1.searchParams.get('show_ids'), '66837');
    assert.equal(resolvedUrl1.searchParams.get('exclude_airbreaks'), 'true');
    assert.equal(resolvedUrl1.searchParams.get('ordering'), 'airdate');
  } finally {
    globalThis.fetch = originalFetch;
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});

test('kexp_new_music passes rotation_status to plays endpoint', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();
  const originalFetch = globalThis.fetch;
  let capturedUrl: URL | null = null;

  globalThis.fetch = async (input) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    capturedUrl = url;
    return new Response(JSON.stringify({ count: 0, next: null, previous: null, results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await client.callTool({
      name: 'kexp_new_music',
      arguments: { rotation_status: 'Heavy' },
    });

    assert.ok(capturedUrl, 'Expected a fetch call');
    const resolvedUrl2 = capturedUrl as URL;
    assert.equal(resolvedUrl2.searchParams.get('rotation_status'), 'Heavy');
    assert.equal(resolvedUrl2.searchParams.get('exclude_airbreaks'), 'true');
  } finally {
    globalThis.fetch = originalFetch;
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});

test('kexp_local_artist_plays passes is_local=true to plays endpoint', async () => {
  const { server, client, clientTransport, serverTransport } = await createConnectedClientServer();
  const originalFetch = globalThis.fetch;
  let capturedUrl: URL | null = null;

  globalThis.fetch = async (input) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    capturedUrl = url;
    return new Response(JSON.stringify({ count: 0, next: null, previous: null, results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await client.callTool({
      name: 'kexp_local_artist_plays',
      arguments: {},
    });

    assert.ok(capturedUrl, 'Expected a fetch call');
    const resolvedUrl3 = capturedUrl as URL;
    assert.equal(resolvedUrl3.searchParams.get('is_local'), 'true');
    assert.equal(resolvedUrl3.searchParams.get('exclude_airbreaks'), 'true');
  } finally {
    globalThis.fetch = originalFetch;
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});