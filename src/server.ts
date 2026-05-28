import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildKexpItemUrl, buildKexpListUrl, fetchKexpJson } from './kexpClient.js';
import { fetchKexpInStudioEvents } from './kexpEventsClient.js';
import type { KexpQueryValue } from './kexpClient.js';

const MAX_LOOKBACK_DAYS = 30;
const MAX_LOOKBACK_MS = MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

function sanitizeText(text: string): string {
  return text.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: sanitizeText(`Error: ${message}`) }], isError: true as const };
}

function okResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: sanitizeText(JSON.stringify(data)) }] };
}

function parseIsoDate(fieldName: string, value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`\`${fieldName}\` must be a valid ISO 8601 datetime string.`);
  }
  return parsed;
}

function parseIsoDateOnly(fieldName: string, value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`\`${fieldName}\` must be an ISO date in YYYY-MM-DD format.`);
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`\`${fieldName}\` must be a valid ISO date in YYYY-MM-DD format.`);
  }

  return value;
}

function enforcePast30DayWindow(
  afterValue: string | undefined,
  beforeValue: string | undefined,
  afterFieldName: string,
  beforeFieldName: string,
): { after: string; before: string } {
  const now = new Date();
  const oldestAllowed = new Date(now.getTime() - MAX_LOOKBACK_MS);

  const afterDate = afterValue ? parseIsoDate(afterFieldName, afterValue) : oldestAllowed;
  const beforeDate = beforeValue ? parseIsoDate(beforeFieldName, beforeValue) : now;

  if (afterDate < oldestAllowed) {
    throw new Error(`\`${afterFieldName}\` must be within the past ${MAX_LOOKBACK_DAYS} days.`);
  }

  if (beforeDate < oldestAllowed) {
    throw new Error(`\`${beforeFieldName}\` must be within the past ${MAX_LOOKBACK_DAYS} days.`);
  }

  if (afterDate > now) {
    throw new Error(`\`${afterFieldName}\` cannot be in the future.`);
  }

  if (beforeDate > now) {
    throw new Error(`\`${beforeFieldName}\` cannot be in the future.`);
  }

  if (afterDate > beforeDate) {
    throw new Error(`\`${afterFieldName}\` must be earlier than or equal to \`${beforeFieldName}\`.`);
  }

  if (beforeDate.getTime() - afterDate.getTime() > MAX_LOOKBACK_MS) {
    throw new Error(`Date range cannot exceed ${MAX_LOOKBACK_DAYS} days.`);
  }

  return {
    after: afterDate.toISOString(),
    before: beforeDate.toISOString(),
  };
}

export function createKexpMcpServer(): McpServer {
  const server = new McpServer({
    name: 'kexp-mcp-server',
    version: '1.0.0',
  });

  // ─── PLAYS ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'kexp_list_in_studio_events',
    {
      description: 'List upcoming and recent KEXP in-studio performances from the KEXP events web page category filter. This tool scrapes publicly listed in-studio events from https://kexp.org/events/kexp-events/?category=in-studio and returns normalized event details with pagination and optional date filtering.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20)
          .describe('Number of events to return (1-50). Default 20.'),
        offset: z.number().int().min(0).default(0)
          .describe('Number of events to skip for pagination. Default 0.'),
        start_date: z.string().optional()
          .describe('Optional lower date boundary (inclusive) in YYYY-MM-DD format.'),
        end_date: z.string().optional()
          .describe('Optional upper date boundary (inclusive) in YYYY-MM-DD format.'),
      },
    },
    async ({ limit, offset, start_date, end_date }) => {
      try {
        const normalizedStartDate = start_date ? parseIsoDateOnly('start_date', start_date) : undefined;
        const normalizedEndDate = end_date ? parseIsoDateOnly('end_date', end_date) : undefined;

        if (normalizedStartDate && normalizedEndDate && normalizedStartDate > normalizedEndDate) {
          return errorResponse(new Error('`start_date` must be earlier than or equal to `end_date`.'));
        }

        const events = await fetchKexpInStudioEvents();
        const filteredEvents = events.filter((event) => {
          if (normalizedStartDate && event.date_iso < normalizedStartDate) {
            return false;
          }
          if (normalizedEndDate && event.date_iso > normalizedEndDate) {
            return false;
          }
          return true;
        });

        const totalCount = filteredEvents.length;
        const pagedEvents = filteredEvents.slice(offset, offset + limit);
        const nextOffset = offset + limit < totalCount ? offset + limit : null;
        const previousOffset = offset > 0 ? Math.max(0, offset - limit) : null;

        return okResponse({
          source: 'https://kexp.org/events/kexp-events/?category=in-studio',
          total_count: totalCount,
          limit,
          offset,
          next_offset: nextOffset,
          previous_offset: previousOffset,
          events: pagedEvents,
        });
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  server.registerTool(
    'kexp_list_plays',
    {
      description: 'List plays from KEXP radio, limited to a maximum lookback window of the past 30 days. Each play is either a trackplay (a song was played) or an airbreak (station ID / non-music segment). Results are ordered newest-first by default. Supports filtering by one or more KEXP show IDs, artist, play type, and date range. If no date bounds are provided, the server defaults to the last 30 days.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20)
          .describe('Number of results to return (1–50). Default 20. Use pagination via `offset` for larger result sets.'),
        offset: z.number().int().min(0).default(0)
          .describe('Number of results to skip for pagination. Default 0.'),
        show_ids: z.union([
          z.number().int().positive(),
          z.array(z.number().int().positive()).min(1),
        ]).optional()
          .describe('Filter by one or more show IDs. Sent to the KEXP plays endpoint as comma-separated `show_ids`.'),
        airdate_before: z.string().optional()
          .describe('ISO 8601 datetime string. Only return plays that aired before this time. Must be within the past 30 days. If omitted, defaults to now.'),
        airdate_after: z.string().optional()
          .describe('ISO 8601 datetime string. Only return plays that aired after this time. Must be within the past 30 days. If omitted, defaults to 30 days ago.'),
        artist: z.string().optional()
          .describe('Filter by artist name (case-insensitive substring match). Example: "Radiohead".'),
        play_type: z.enum(['trackplay', 'airbreak']).optional()
          .describe('"trackplay" = a song was played; "airbreak" = station break or non-music segment.'),
        exclude_airbreaks: z.boolean().optional()
          .describe('Exclude airbreak entries from the results. Useful for song-only results.'),
        ordering: z.string().default('-airdate')
          .describe('Sort order field. "-airdate" = newest first (default); "airdate" = oldest first.'),
      },
    },
    async ({ limit, offset, show_ids, airdate_before, airdate_after, artist, play_type, exclude_airbreaks, ordering }) => {
      try {
        const boundedRange = enforcePast30DayWindow(
          airdate_after,
          airdate_before,
          'airdate_after',
          'airdate_before',
        );

        const query: Record<string, KexpQueryValue> = { ordering };
        const requestedShowIds = show_ids === undefined ? [] : Array.isArray(show_ids) ? show_ids : [show_ids];
        if (requestedShowIds.length > 0) {
          query.show_ids = [...new Set(requestedShowIds)].join(',');
        }
        query.airdate_after = boundedRange.after;
        query.airdate_before = boundedRange.before;
        if (artist) query.artist = artist;
        if (play_type) query.play_type = play_type;
        if (exclude_airbreaks !== undefined) query.exclude_airbreaks = exclude_airbreaks;
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
      description: 'List KEXP radio shows (broadcast episodes), limited to a maximum lookback window of the past 30 days. A show is a single on-air session associated with a named program and one or more hosts. Use this to find recent shows, shows for a specific program, or shows within a time range. If no date bounds are provided, the server defaults to the last 30 days. To find shows by a specific host, use kexp_list_shows_by_host instead.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20)
          .describe('Number of results to return (1–50). Default 20. Use pagination via `offset` for larger result sets.'),
        offset: z.number().int().min(0).default(0)
          .describe('Number of results to skip for pagination. Default 0.'),
        program: z.number().int().positive().optional()
          .describe('Filter by program ID. Returns only shows that belong to this program.'),
        start_time_after: z.string().optional()
          .describe('ISO 8601 datetime. Only return shows that started after this time. Must be within the past 30 days. If omitted, defaults to 30 days ago.'),
        start_time_before: z.string().optional()
          .describe('ISO 8601 datetime. Only return shows that started before this time. Must be within the past 30 days. If omitted, defaults to now.'),
        playlist_location: z.number().int().positive().optional()
          .describe('Filter by broadcast location ID. 1 = Default/main broadcast stream.'),
      },
    },
    async ({ limit, offset, program, start_time_after, start_time_before, playlist_location }) => {
      try {
        if (limit > 50) {
          return errorResponse(new Error('`limit` must be an integer between 1 and 50 (inclusive).'));
        }

        const boundedRange = enforcePast30DayWindow(
          start_time_after,
          start_time_before,
          'start_time_after',
          'start_time_before',
        );

        const query: Record<string, KexpQueryValue> = {};
        if (program !== undefined) query.program = program;
        query.start_time_after = boundedRange.after;
        query.start_time_before = boundedRange.before;
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
      description: 'Find KEXP shows hosted by a specific DJ within a time range limited to the past 30 days. Use this to answer questions like "how many shows did [DJ name] do this week?" or "what has [DJ] hosted recently?". Accepts a host name (partial, case-insensitive match) or a numeric host ID. Automatically paginates through shows in that 30-day window and filters client-side, since the KEXP API does not support host filtering on the shows endpoint. Supports paginated output via limit/offset.',
      inputSchema: {
        host_name: z.string().optional()
          .describe('Name or partial name of the host (case-insensitive substring match). Either host_name or host_id must be provided.'),
        host_id: z.number().int().positive().optional()
          .describe('Numeric host ID. Either host_name or host_id must be provided.'),
        limit: z.number().int().min(1).max(50).default(20)
          .describe('Number of matched shows to return (1–50). Default 20.'),
        offset: z.number().int().min(0).default(0)
          .describe('Number of matched shows to skip for pagination. Default 0.'),
        start_time_after: z.string().optional()
          .describe('ISO 8601 datetime. Only return shows that started after this time. Must be within the past 30 days. If omitted, defaults to 30 days ago.'),
        start_time_before: z.string().optional()
          .describe('ISO 8601 datetime. Only return shows that started before this time. Must be within the past 30 days. If omitted, defaults to now.'),
      },
    },
    async ({ host_name, host_id, limit, offset, start_time_after, start_time_before }) => {
      try {
        if (limit > 50) {
          return errorResponse(new Error('`limit` must be an integer between 1 and 50 (inclusive).'));
        }

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
        const boundedRange = enforcePast30DayWindow(
          start_time_after,
          start_time_before,
          'start_time_after',
          'start_time_before',
        );
        const showQuery: Record<string, KexpQueryValue> = {
          start_time_after: boundedRange.after,
          start_time_before: boundedRange.before,
        };

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

        const totalCount = matchedShows.length;
        const pagedShows = matchedShows.slice(offset, offset + limit);
        const nextOffset = offset + limit < totalCount ? offset + limit : null;
        const previousOffset = offset > 0 ? Math.max(0, offset - limit) : null;

        return okResponse({
          host: { id: resolvedHostId, name: resolvedHostName },
          total_count: totalCount,
          limit,
          offset,
          next_offset: nextOffset,
          previous_offset: previousOffset,
          shows: pagedShows,
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
