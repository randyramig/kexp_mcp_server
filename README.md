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

### Plays

| Tool | Description |
|---|---|
| `kexp_list_plays` | List plays (songs and airbreaks) with optional filters for artist, show, play type, and date range. Paginated. |
| `kexp_get_play` | Get a single play by ID — includes song, artist, album, airdate, DJ comment, labels, and MusicBrainz IDs. |

**`kexp_list_plays` parameters:**

| Parameter | Type | Description |
|---|---|---|
| `limit` | number | Results per page (1–200, default 20) |
| `offset` | number | Pagination offset (default 0) |
| `show` | number | Filter by show ID |
| `airdate_before` | string | ISO 8601 datetime — plays before this time |
| `airdate_after` | string | ISO 8601 datetime — plays after this time |
| `artist` | string | Artist name substring filter |
| `play_type` | `trackplay` \| `airbreak` | Filter by play type |
| `ordering` | string | Sort field, e.g. `-airdate` (default) or `airdate` |

### Shows

| Tool | Description |
|---|---|
| `kexp_list_shows` | List broadcast episodes (shows). Filter by program, host, or time range. |
| `kexp_get_show` | Get a single show by ID — includes program, hosts, tagline, start time, and images. |

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
