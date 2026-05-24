import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildKexpItemUrl, buildKexpListUrl, fetchKexpJson } from './kexpClient.js';
import type { KexpQueryValue } from './kexpClient.js';

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true as const };
}

function okResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function createKexpMcpServer(): McpServer {
  const server = new McpServer({
    name: 'kexp-mcp-server',
    version: '1.0.0',
  });

  // ─── PLAYS ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'kexp_list_plays',
    {
      description: 'List plays from KEXP radio. Each play is either a trackplay (a song was played) or an airbreak (station ID / non-music segment). Results are ordered newest-first by default. Use this to see what is currently on air, browse recent music, search by artist, or get the playlist for a specific show.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(20)
          .describe('Number of results to return (1–200). Default 20.'),
        offset: z.number().int().min(0).default(0)
          .describe('Number of results to skip for pagination. Default 0.'),
        show: z.number().int().positive().optional()
          .describe('Filter by show ID. Returns only plays that aired during this show.'),
        airdate_before: z.string().optional()
          .describe('ISO 8601 datetime string. Only return plays that aired before this time. Example: "2026-05-23T12:00:00-07:00".'),
        airdate_after: z.string().optional()
          .describe('ISO 8601 datetime string. Only return plays that aired after this time.'),
        artist: z.string().optional()
          .describe('Filter by artist name (case-insensitive substring match). Example: "Radiohead".'),
        play_type: z.enum(['trackplay', 'airbreak']).optional()
          .describe('"trackplay" = a song was played; "airbreak" = station break or non-music segment.'),
        ordering: z.string().default('-airdate')
          .describe('Sort order field. "-airdate" = newest first (default); "airdate" = oldest first.'),
      },
    },
    async ({ limit, offset, show, airdate_before, airdate_after, artist, play_type, ordering }) => {
      try {
        const query: Record<string, KexpQueryValue> = { ordering };
        if (show !== undefined) query.show = show;
        if (airdate_before) query.airdate_before = airdate_before;
        if (airdate_after) query.airdate_after = airdate_after;
        if (artist) query.artist = artist;
        if (play_type) query.play_type = play_type;
        const url = buildKexpListUrl({ endpoint: 'plays', limit, offset, query });
        return okResponse(await fetchKexpJson(url));
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  server.registerTool(
    'kexp_get_play',
    {
      description: 'Get a single KEXP play record by its numeric ID. Returns full details: song title, artist, album, airdate, labels, MusicBrainz IDs, rotation status, whether the song was a local/request/live performance, the DJ comment, and broadcast location.',
      inputSchema: {
        id: z.string().regex(/^\d+$/).describe('The numeric play ID.'),
      },
    },
    async ({ id }) => {
      try {
        return okResponse(await fetchKexpJson(buildKexpItemUrl({ endpoint: 'plays', id })));
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // ─── SHOWS ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'kexp_list_shows',
    {
      description: 'List KEXP radio shows (broadcast episodes). A show is a single on-air session associated with a named program and one or more hosts. Use this to find recent shows, shows for a specific program, or shows within a time range. To find shows by a specific host, use kexp_list_shows_by_host instead.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(20)
          .describe('Number of results to return (1–200). Default 20.'),
        offset: z.number().int().min(0).default(0)
          .describe('Number of results to skip for pagination. Default 0.'),
        program: z.number().int().positive().optional()
          .describe('Filter by program ID. Returns only shows that belong to this program.'),
        start_time_after: z.string().optional()
          .describe('ISO 8601 datetime. Only return shows that started after this time.'),
        start_time_before: z.string().optional()
          .describe('ISO 8601 datetime. Only return shows that started before this time.'),
        playlist_location: z.number().int().positive().optional()
          .describe('Filter by broadcast location ID. 1 = Default/main broadcast stream.'),
      },
    },
    async ({ limit, offset, program, start_time_after, start_time_before, playlist_location }) => {
      try {
        const query: Record<string, KexpQueryValue> = {};
        if (program !== undefined) query.program = program;
        if (start_time_after) query.start_time_after = start_time_after;
        if (start_time_before) query.start_time_before = start_time_before;
        if (playlist_location !== undefined) query.playlist_location = playlist_location;
        const url = buildKexpListUrl({ endpoint: 'shows', limit, offset, query });
        return okResponse(await fetchKexpJson(url));
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  server.registerTool(
    'kexp_get_show',
    {
      description: 'Get a single KEXP radio show by its numeric ID. Returns full details: program name and tags, host names, tagline, start time, broadcast location, and image URLs for both the show and the program.',
      inputSchema: {
        id: z.string().regex(/^\d+$/).describe('The numeric show ID.'),
      },
    },
    async ({ id }) => {
      try {
        return okResponse(await fetchKexpJson(buildKexpItemUrl({ endpoint: 'shows', id })));
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  server.registerTool(
    'kexp_list_shows_by_host',
    {
      description: 'Find all KEXP shows hosted by a specific DJ within an optional time range. Use this to answer questions like "how many shows did [DJ name] do this week?" or "what has [DJ] hosted recently?". Accepts a host name (partial, case-insensitive match) or a numeric host ID. Automatically paginates through all shows and filters client-side, since the KEXP API does not support host filtering on the shows endpoint.',
      inputSchema: {
        host_name: z.string().optional()
          .describe('Name or partial name of the host (case-insensitive substring match). Either host_name or host_id must be provided.'),
        host_id: z.number().int().positive().optional()
          .describe('Numeric host ID. Either host_name or host_id must be provided.'),
        start_time_after: z.string().optional()
          .describe('ISO 8601 datetime. Only return shows that started after this time.'),
        start_time_before: z.string().optional()
          .describe('ISO 8601 datetime. Only return shows that started before this time.'),
      },
    },
    async ({ host_name, host_id, start_time_after, start_time_before }) => {
      try {
        if (host_id === undefined && !host_name) {
          return errorResponse(new Error('Either host_name or host_id must be provided.'));
        }

        // Step 1: Resolve host ID (and canonical name) from a name string if needed
        let resolvedHostId: number;
        let resolvedHostName: string;

        if (host_id !== undefined) {
          resolvedHostId = host_id;
          resolvedHostName = `Host ID ${host_id}`;
        } else {
          const hostsUrl = buildKexpListUrl({ endpoint: 'hosts', limit: 200, offset: 0 });
          const hostsData = await fetchKexpJson(hostsUrl) as { results: Array<{ id: number; name: string }> };
          const needle = host_name!.toLowerCase();
          const match = hostsData.results.find(h => h.name.toLowerCase().includes(needle));
          if (!match) {
            return errorResponse(new Error(`No host found matching "${host_name}". Use kexp_list_hosts to browse available hosts.`));
          }
          resolvedHostId = match.id;
          resolvedHostName = match.name;
        }

        // Step 2: Paginate through all shows in the time range, filtering client-side
        const matchedShows: unknown[] = [];
        const showQuery: Record<string, KexpQueryValue> = {};
        if (start_time_after) showQuery.start_time_after = start_time_after;
        if (start_time_before) showQuery.start_time_before = start_time_before;

        let nextUrl: URL | string | null = buildKexpListUrl({ endpoint: 'shows', limit: 200, offset: 0, query: showQuery });
        while (nextUrl) {
          const url = typeof nextUrl === 'string' ? new URL(nextUrl) : nextUrl;
          const page = await fetchKexpJson(url) as { next: string | null; results: Array<{ hosts: number[] }> };
          for (const show of page.results) {
            if (show.hosts.includes(resolvedHostId)) {
              matchedShows.push(show);
            }
          }
          nextUrl = page.next;
        }

        return okResponse({
          host: { id: resolvedHostId, name: resolvedHostName },
          total_count: matchedShows.length,
          shows: matchedShows,
        });
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // ─── HOSTS ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'kexp_list_hosts',
    {
      description: 'List KEXP radio DJs and hosts. Use is_active=true to get only currently active on-air hosts. Use name to find a specific host by name (case-insensitive substring match). Returns name, image URL, and active status for each host.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(20)
          .describe('Number of results to return (1–200). Default 20.'),
        offset: z.number().int().min(0).default(0)
          .describe('Number of results to skip for pagination. Default 0.'),
        is_active: z.boolean().optional()
          .describe('Filter by active status. true = currently active on-air DJs; false = former DJs.'),
        name: z.string().optional()
          .describe('Filter by host name (case-insensitive substring match). Example: "John" returns all hosts with "John" in their name.'),
      },
    },
    async ({ limit, offset, is_active, name }) => {
      try {
        const query: Record<string, KexpQueryValue> = {};
        if (is_active !== undefined) query.is_active = is_active;

        if (name) {
          // Fetch all hosts and filter client-side — the host list is small enough to fit in one page
          const url = buildKexpListUrl({ endpoint: 'hosts', limit: 200, offset: 0, query });
          const data = await fetchKexpJson(url) as { results: Array<{ name: string }> };
          const needle = name.toLowerCase();
          const filtered = data.results.filter(h => h.name.toLowerCase().includes(needle));
          return okResponse({ count: filtered.length, next: null, previous: null, results: filtered });
        }

        const url = buildKexpListUrl({ endpoint: 'hosts', limit, offset, query });
        return okResponse(await fetchKexpJson(url));
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  server.registerTool(
    'kexp_get_host',
    {
      description: 'Get a single KEXP host (DJ) by their numeric ID. Returns name, image URL, thumbnail URL, active status, and broadcast location.',
      inputSchema: {
        id: z.string().regex(/^\d+$/).describe('The numeric host ID.'),
      },
    },
    async ({ id }) => {
      try {
        return okResponse(await fetchKexpJson(buildKexpItemUrl({ endpoint: 'hosts', id })));
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // ─── PROGRAMS ───────────────────────────────────────────────────────────────

  server.registerTool(
    'kexp_list_programs',
    {
      description: 'List KEXP radio programs. A program is a named recurring show series (e.g., "Variety Mix", "Jazz Theatre", "Audioasis"). Use is_active=true to get only currently airing programs.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(20)
          .describe('Number of results to return (1–200). Default 20.'),
        offset: z.number().int().min(0).default(0)
          .describe('Number of results to skip for pagination. Default 0.'),
        is_active: z.boolean().optional()
          .describe('Filter by active status. true = currently airing programs; false = discontinued programs.'),
      },
    },
    async ({ limit, offset, is_active }) => {
      try {
        const query: Record<string, KexpQueryValue> = {};
        if (is_active !== undefined) query.is_active = is_active;
        const url = buildKexpListUrl({ endpoint: 'programs', limit, offset, query });
        return okResponse(await fetchKexpJson(url));
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  server.registerTool(
    'kexp_get_program',
    {
      description: 'Get a single KEXP program by its numeric ID. Returns name, description, genre tags, image URLs, active status, and broadcast location.',
      inputSchema: {
        id: z.string().regex(/^\d+$/).describe('The numeric program ID.'),
      },
    },
    async ({ id }) => {
      try {
        return okResponse(await fetchKexpJson(buildKexpItemUrl({ endpoint: 'programs', id })));
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // ─── TIMESLOTS ──────────────────────────────────────────────────────────────

  server.registerTool(
    'kexp_list_timeslots',
    {
      description: 'List KEXP weekly schedule timeslots. Each timeslot defines when a program airs on a given weekday — including start time, end time, duration, program, and hosts. Use this to explore the full KEXP broadcast schedule.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(20)
          .describe('Number of results to return (1–200). Default 20.'),
        offset: z.number().int().min(0).default(0)
          .describe('Number of results to skip for pagination. Default 0.'),
        program: z.number().int().positive().optional()
          .describe('Filter by program ID. Returns only timeslots for this program.'),
        weekday: z.number().int().min(1).max(7).optional()
          .describe('Filter by weekday. 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday, 7=Sunday.'),
      },
    },
    async ({ limit, offset, program, weekday }) => {
      try {
        const query: Record<string, KexpQueryValue> = {};
        if (program !== undefined) query.program = program;
        if (weekday !== undefined) query.weekday = weekday;
        const url = buildKexpListUrl({ endpoint: 'timeslots', limit, offset, query });
        return okResponse(await fetchKexpJson(url));
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  server.registerTool(
    'kexp_get_timeslot',
    {
      description: 'Get a single KEXP schedule timeslot by its numeric ID. Returns the program, weekday, start/end times, duration, host names, and schedule start/end dates.',
      inputSchema: {
        id: z.string().regex(/^\d+$/).describe('The numeric timeslot ID.'),
      },
    },
    async ({ id }) => {
      try {
        return okResponse(await fetchKexpJson(buildKexpItemUrl({ endpoint: 'timeslots', id })));
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  return server;
}
