# AGENTS

This repository hosts a Node.js + TypeScript MCP server that wraps the KEXP REST API at `https://api.kexp.org/v2/`.

## Project Context

- Runtime: Node.js
- Language: TypeScript
- Protocol: Model Context Protocol (MCP)
- Supported transports:
  - Local process transport via `StdioServerTransport`
  - HTTP transport via `SSEServerTransport`

## Working Expectations

- Keep tools narrowly scoped and strongly typed.
- Validate all input parameters before making outbound API requests.
- Return structured output when possible, plus clear text responses for model usability.
- Keep transport behavior explicit:
  - `stdio` for local CLI integrations
  - `sse` for network clients using GET `/sse` + POST `/messages`

## Key Design Tips

Write good tool descriptions — the AI uses these to decide when to call each tool. Be specific about what each tool does and what its parameters mean.

Return useful errors — if a call fails, return a descriptive error message so the AI can reason about it.

Keep tools focused — one tool per logical operation. Don't make a single "do everything" tool.

Pagination awareness — if your REST API paginates, expose that in your tool so the AI can fetch more results if needed.
