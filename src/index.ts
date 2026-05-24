import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createKexpMcpServer } from './server.js';

type SessionState = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

function readCliFlag(name: string): string | undefined {
  const prefixed = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefixed));
  return match ? match.slice(prefixed.length) : undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const bodyText = Buffer.concat(chunks).toString('utf8').trim();
  if (!bodyText) {
    return undefined;
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function writeJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function startStdioServer(): Promise<void> {
  const server = createKexpMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startSseServer(port: number, host?: string): Promise<void> {
  const sessions = new Map<string, SessionState>();

  const httpServer = createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (method === 'GET' && requestUrl.pathname === '/health') {
        writeJson(res, 200, { ok: true });
        return;
      }

      if (requestUrl.pathname === '/mcp' && (method === 'GET' || method === 'POST' || method === 'DELETE')) {
        const parsedBody = method === 'POST' ? await readJsonBody(req) : undefined;
        const mcpSessionHeader = req.headers['mcp-session-id'];
        const mcpSessionId = Array.isArray(mcpSessionHeader) ? mcpSessionHeader[0] : mcpSessionHeader;
        let session = mcpSessionId ? sessions.get(mcpSessionId) : undefined;

        if (!session) {
          if (method !== 'POST' || !parsedBody || !isInitializeRequest(parsedBody)) {
            writeJson(res, 400, {
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Bad Request: No valid MCP session. Initialize first with POST /mcp.',
              },
              id: null,
            });
            return;
          }

          const server = createKexpMcpServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
              sessions.set(sessionId, { transport, server });
            },
          });

          transport.onclose = () => {
            const sessionId = transport.sessionId;
            if (sessionId) {
              sessions.delete(sessionId);
            }
            void server.close();
          };

          await server.connect(transport as Parameters<McpServer['connect']>[0]);
          session = { transport, server };
        }

        await session.transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (requestUrl.pathname === '/sse' || requestUrl.pathname === '/messages') {
        writeJson(res, 410, {
          error: 'Deprecated route. Use /mcp with Streamable HTTP transport.',
        });
        return;
      }

      writeJson(res, 404, {
        error: 'Route not found. Use /mcp for MCP requests and GET /health for liveness.',
      });
    } catch (error) {
      process.stderr.write(
        `SSE request handling failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      writeJson(res, 500, {
        error: 'Internal server error while handling the request.',
      });
    }
  });

  httpServer.listen(port, host, () => {
    const displayHost = host || '0.0.0.0';
    process.stderr.write(`KEXP MCP SSE server listening on http://${displayHost}:${port}\n`);
  });

  const shutdown = async (): Promise<void> => {
    httpServer.close();
    for (const { transport, server } of sessions.values()) {
      await transport.close();
      await server.close();
    }
    sessions.clear();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

async function main(): Promise<void> {
  const transport = readCliFlag('transport') ?? process.env.TRANSPORT ?? 'stdio';

  if (transport === 'stdio') {
    await startStdioServer();
    return;
  }

  if (transport === 'sse' || transport === 'http' || transport === 'streamable-http') {
    const portFlag = readCliFlag('port');
    const hostFlag = readCliFlag('host');
    const portEnv = process.env.PORT;
    const hostEnv = process.env.HOST;
    const parsedPort = Number(portFlag ?? portEnv ?? '3000');
    const host = hostFlag ?? hostEnv ?? '0.0.0.0';

    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error('Port must be an integer between 1 and 65535.');
    }

    await startSseServer(parsedPort, host);
    return;
  }

  throw new Error(`Unsupported transport: ${transport}. Use "stdio", "sse", "http", or "streamable-http".`);
}

main().catch((error) => {
  process.stderr.write(`KEXP MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
