import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createKexpMcpServer } from './server.js';

type SessionState = {
  transport: SSEServerTransport;
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

async function startSseServer(port: number): Promise<void> {
  const sessions = new Map<string, SessionState>();

  const httpServer = createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (method === 'GET' && requestUrl.pathname === '/sse') {
        const server = createKexpMcpServer();
        const transport = new SSEServerTransport('/messages', res);
        const sessionId = transport.sessionId;

        sessions.set(sessionId, { transport, server });

        transport.onclose = () => {
          const session = sessions.get(sessionId);
          sessions.delete(sessionId);
          void session?.server.close();
        };

        await server.connect(transport);
        return;
      }

      if (method === 'POST' && requestUrl.pathname === '/messages') {
        const sessionId = requestUrl.searchParams.get('sessionId');

        if (!sessionId) {
          writeJson(res, 400, { error: 'Missing required query parameter: sessionId' });
          return;
        }

        const session = sessions.get(sessionId);
        if (!session) {
          writeJson(res, 404, { error: `No active SSE session found for sessionId: ${sessionId}` });
          return;
        }

        const parsedBody = await readJsonBody(req);
        await session.transport.handlePostMessage(req, res, parsedBody);
        return;
      }

      writeJson(res, 404, {
        error: 'Route not found. Use GET /sse to start an SSE session and POST /messages?sessionId=<id> for JSON-RPC messages.',
      });
    } catch (error) {
      writeJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  httpServer.listen(port, () => {
    process.stderr.write(`KEXP MCP SSE server listening on http://localhost:${port}\n`);
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

  if (transport === 'sse') {
    const portFlag = readCliFlag('port');
    const portEnv = process.env.PORT;
    const parsedPort = Number(portFlag ?? portEnv ?? '3000');

    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error('Port must be an integer between 1 and 65535.');
    }

    await startSseServer(parsedPort);
    return;
  }

  throw new Error(`Unsupported transport: ${transport}. Use "stdio" or "sse".`);
}

main().catch((error) => {
  process.stderr.write(`KEXP MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
