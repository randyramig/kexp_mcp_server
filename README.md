# kexp_mcp_server

A TypeScript MCP server for the KEXP REST API (`https://api.kexp.org/v2/`) that supports:

- `StdioServerTransport` for local MCP clients
- `SSEServerTransport` for HTTP/SSE MCP clients

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

- `GET /sse` to establish the SSE stream
- `POST /messages?sessionId=<id>` for JSON-RPC messages

## Build and test

```bash
npm run build
npm test
```
