import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface HttpOptions {
  /** Builds a fresh MCP server for each request (stateless mode). */
  createServer: () => McpServer;
  port: number;
  host?: string;
  /** Path the MCP endpoint is served on (default /mcp). */
  path?: string;
  /** Max request body in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  onError?: (e: unknown) => void;
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/**
 * Serves MCP over streamable HTTP in stateless mode: every POST gets its own server and transport, so any
 * number of clients can call the read-only tools without sessions. GET /healthz answers 200.
 */
export function startHttpServer(options: HttpOptions): Promise<Server> {
  const path = options.path ?? "/mcp";
  const limit = options.maxBodyBytes ?? 1024 * 1024;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz" && req.method === "GET") return sendJson(res, 200, { ok: true });
    if (url.pathname !== path) return rpcError(res, 404, "not found");
    if (req.method !== "POST") return rpcError(res, 405, "method not allowed; this server is stateless, POST only");

    try {
      const body = await readJson(req, limit);
      const mcp = options.createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      options.onError?.(e);
      if (!res.headersSent) {
        const status = (e as { status?: number }).status ?? 500;
        rpcError(res, status, status === 500 ? "internal error" : (e as Error).message);
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => resolve(server));
  });
}
