# kexp_mcp_server

A TypeScript MCP server for the [KEXP radio](https://www.kexp.org) REST API (`https://api.kexp.org/v2/`). Exposes KEXP's plays, shows, hosts, programs, and schedule as MCP tools so AI assistants can browse what's on air, search by artist, and explore the full broadcast schedule.

Supports:
- `StdioServerTransport` for local MCP clients (Claude Desktop, etc.)
- `StreamableHTTPServerTransport` for HTTP MCP clients

## Setup

```bash
npm install
```

## Run locally over stdio

```bash
npm run start:stdio
```

## Run over HTTP/SSE

```bash
npm run start:sse
```

By default, the SSE server runs on port `3000` and exposes:

- `POST /mcp` — initialize session and send JSON-RPC requests
- `GET /mcp` — receive stream responses/events for an active MCP session
- `DELETE /mcp` — terminate an active MCP session
- `GET /health` — simple health check endpoint returning `{ "ok": true }`

Legacy routes `GET /sse` and `POST /messages` are deprecated and return `410 Gone`.

When deploying, the server also respects:

- `PORT` (or `--port=`) for the HTTP port
- `HOST` (or `--host=`) for the bind address (defaults to `0.0.0.0`)

## Deploy on Railway

This repo includes a `railway.toml` so Railway can build and run it with SSE transport.

1. Create a new Railway project from this repo.
2. Railway will run:
  - Build: `npm ci && npm run build`
  - Start: `npm run start`
3. Set `TRANSPORT=sse` if you override start behavior.

Railway injects `PORT` automatically, and this server binds to `0.0.0.0` by default.

### Watching Railway logs for MCP requests

The HTTP transport emits structured JSON logs to stderr for each MCP request:

- `mcp.request` when a request enters `/mcp`
- `mcp.response` when the response finishes
- `mcp.error` for unhandled request errors

Each entry includes correlation fields you can search in Railway logs:

- `jsonrpc_id`
- `jsonrpc_method`
- `tool_name` (for `tools/call`, for example `kexp_list_plays`)
- `mcp_session_id`
- `http_request_id` (from `x-request-id`, `x-correlation-id`, or `x-amzn-trace-id` when present)

Example log line:

```json
{"ts":"2026-05-24T00:00:00.000Z","event":"mcp.request","http_method":"POST","path":"/mcp","mcp_session_id":"6a6f...","http_request_id":"req_123","jsonrpc_id":"call_abc","jsonrpc_method":"tools/call","tool_name":"kexp_list_plays"}
```

If an external request ID from your client does not match `http_request_id`, use timestamp + `tool_name` + `jsonrpc_id` + `mcp_session_id` together to correlate calls.

## Build and test

```bash
npm run build
npm test
```

## Claude Desktop configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kexp": {
      "command": "node",
      "args": ["/absolute/path/to/kexp_mcp_server/dist/index.js", "--transport=stdio"]
    }
  }
}
```

Run `npm run build` first to produce `dist/index.js`.

## Available tools

Date window policy:
- Date-based list tools are constrained to the past 30 days to reduce upstream API load.
- If date bounds are omitted, the server defaults to a 30-day window ending at now.

### Plays

| Tool | Description |
|---|---|
| `kexp_list_in_studio_events` | Scrape KEXP in-studio performances from the public events page (`category=in-studio`) with optional date filtering and pagination. |
| `kexp_list_plays` | List plays (songs and airbreaks) with optional filters for artist, `show_ids`, play type, `exclude_airbreaks`, and date range. Date range is limited to the past 30 days. Paginated. |
| `kexp_get_play` | Get a single play by ID — includes song, artist, album, airdate, DJ comment, labels, and MusicBrainz IDs. |

**`kexp_list_plays` parameters:**

| Parameter | Type | Description |
|---|---|---|
| `limit` | number | Results per page (1–50, default 20). Use `offset` for pagination. |
| `offset` | number | Pagination offset (default 0) |
| `show_ids` | number \| number[] | Filter by one or more show IDs. Sent to the KEXP plays endpoint as comma-separated `show_ids`. |
| `airdate_before` | string | ISO 8601 datetime — plays before this time (must be within past 30 days; defaults to now) |
| `airdate_after` | string | ISO 8601 datetime — plays after this time (must be within past 30 days; defaults to 30 days ago) |
| `artist` | string | Artist name substring filter |
| `play_type` | `trackplay` \| `airbreak` | Filter by play type |
| `exclude_airbreaks` | boolean | When `true`, omit airbreak entries from the results |
| `ordering` | string | Sort field, e.g. `-airdate` (default) or `airdate` |

**`kexp_list_in_studio_events` parameters:**

| Parameter | Type | Description |
|---|---|---|
| `limit` | number | Results per page (1–50, default 20). Use `offset` for pagination. |
| `offset` | number | Pagination offset (default 0) |
| `start_date` | string | Optional lower date boundary (inclusive), format `YYYY-MM-DD` |
| `end_date` | string | Optional upper date boundary (inclusive), format `YYYY-MM-DD` |

**`kexp_list_in_studio_events` output fields:**

- `id`, `title`, `url`, `date_text`, `date_iso`, `time_text`, `venue`, `photo_credit`, `is_open_to_public`
- Pagination metadata: `total_count`, `limit`, `offset`, `next_offset`, `previous_offset`

### Shows

| Tool | Description |
|---|---|
| `kexp_list_shows` | List broadcast episodes (shows). Filter by program, host, or time range. Date range is limited to the past 30 days. |
| `kexp_get_show` | Get a single show by ID — includes program, hosts, tagline, start time, and images. |

**`kexp_list_shows` parameters:**

| Parameter | Type | Description |
|---|---|---|
| `limit` | number | Results per page (1–50, default 20). Use `offset` for pagination. |
| `offset` | number | Pagination offset (default 0) |
| `program` | number | Filter by program ID |
| `start_time_before` | string | ISO 8601 datetime — shows before this time (must be within past 30 days; defaults to now) |
| `start_time_after` | string | ISO 8601 datetime — shows after this time (must be within past 30 days; defaults to 30 days ago) |
| `playlist_location` | number | Filter by broadcast location ID |

**`kexp_list_shows_by_host` note:**

- Host-based show searches are also constrained to the past 30 days.
- The tool paginates its output with `limit` (1–50, default 20) and `offset` (default 0), and returns `next_offset` / `previous_offset` to request adjacent pages.

### Hosts

| Tool | Description |
|---|---|
| `kexp_list_hosts` | List KEXP DJs and hosts. Filter by `is_active` to get current on-air hosts. |
| `kexp_get_host` | Get a single host by ID. |

### Programs

| Tool | Description |
|---|---|
| `kexp_list_programs` | List KEXP programs (named recurring show series like "Variety Mix" or "Jazz Theatre"). |
| `kexp_get_program` | Get a single program by ID — includes name, description, genre tags, and images. |

### Timeslots

| Tool | Description |
|---|---|
| `kexp_list_timeslots` | List weekly schedule timeslots. Filter by `program` or `weekday` (1=Mon … 7=Sun). |
| `kexp_get_timeslot` | Get a single timeslot by ID — includes weekday, start/end times, duration, and hosts. |

## API

All data comes from the public KEXP REST API at `https://api.kexp.org/v2/`. No API key required.

 https://kexpmcpserver-production.up.railway.app
