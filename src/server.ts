import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildKexpItemUrl, buildKexpListUrl, fetchKexpJson } from './kexpClient.js';

export function createKexpMcpServer(): McpServer {
  const server = new McpServer({
    name: 'kexp-mcp-server',
    version: '1.0.0',
  });

  server.registerTool(
    'kexp_list_resources',
    {
      description:
        'List resources from a KEXP REST API endpoint with pagination. Use this for collection endpoints such as shows or plays, and provide page/limit when you need additional results.',
      inputSchema: z.object({
        endpoint: z
          .string()
          .describe('The KEXP v2 collection endpoint path, relative to https://api.kexp.org/v2/ (for example: plays or shows).'),
        page: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe('The result page number to fetch. Starts at 1.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Maximum number of items per page (1-100).'),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Optional additional KEXP query parameters as key/value pairs.'),
      }),
    },
    async ({ endpoint, page, limit, query }) => {
      try {
        const url = buildKexpListUrl({
          endpoint,
          page,
          limit,
          ...(query ? { query } : {}),
        });
        const data = await fetchKexpJson(url);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
          structuredContent: {
            endpoint,
            page,
            limit,
            url: url.toString(),
            data,
          },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Unable to list KEXP resources from endpoint "${endpoint}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    'kexp_get_resource_by_id',
    {
      description:
        'Get a single KEXP REST API resource by endpoint and id. Use this when you already know the identifier for an item returned from a list query.',
      inputSchema: z.object({
        endpoint: z
          .string()
          .describe('The KEXP v2 endpoint path, relative to https://api.kexp.org/v2/ (for example: plays or shows).'),
        id: z.string().describe('The resource identifier within the endpoint to fetch.'),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Optional additional query parameters as key/value pairs.'),
      }),
    },
    async ({ endpoint, id, query }) => {
      try {
        const url = buildKexpItemUrl({
          endpoint,
          id,
          ...(query ? { query } : {}),
        });
        const data = await fetchKexpJson(url);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
          structuredContent: {
            endpoint,
            id,
            url: url.toString(),
            data,
          },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Unable to fetch KEXP resource "${id}" from endpoint "${endpoint}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  return server;
}
