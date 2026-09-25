import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../mcp/server.mjs";

export function createHttpServer({ client, verifyAccess }) {
  return createServer(async (request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    if (!(await verifyAccess(request))) {
      response.writeHead(403).end();
      return;
    }
    const server = createMcpServer(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      process.stderr.write("t3code-mcp: request failed\n");
      if (!response.headersSent) response.writeHead(500).end();
    } finally {
      await transport.close();
      await server.close();
    }
  });
}
