// MCP server. One tool registry (mcp/scopes.js), three transports.
//
//   stdio   `node src/mcp/server.js` — Claude Desktop, Claude Code, any local
//           MCP client that spawns a subprocess.
//   HTTP    POST /mcp — Streamable HTTP, for clients that connect over a URL.
//   SSE     GET /mcp/sse + POST /mcp/messages — the older two-endpoint
//           transport, kept because plenty of clients still only speak it.
//
// A fresh Server instance is built per transport rather than one shared object:
// the SDK binds a Server to a single transport at connect time, so sharing one
// across three would silently attach only the last.
//
// The stdio path must never write to stdout. That stream IS the protocol — a
// stray console.log becomes a malformed JSON-RPC frame and the client drops the
// connection with no useful error. Every log here goes to stderr.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { listTools, callTool, TOOL_COUNT, SCOPE_COUNT, SCOPES } from "./scopes.js";

const SERVER_INFO = { name: "tollpike", version: "0.1.0" };

/**
 * Build a Server bound to the shared registry.
 *
 * @param {{ readOnly?: boolean }} options
 *   readOnly hides mutating tools from the list AND refuses them on call. Hiding
 *   without refusing would leave them reachable by name for any client that
 *   remembered them from a previous session.
 */
export function createMcpServer({ readOnly = false } = {}) {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  // Schema objects, not method strings. `setRequestHandler("tools/list", ...)`
  // throws "Schema is missing a method literal" at import time.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools()
      .filter((tool) => !(readOnly && tool.mutates))
      .map((tool) => ({
        name: tool.name,
        // The mutation marker is in the description because MCP has no field for
        // it, and a model choosing between tools should be able to see which one
        // spends money before it calls it.
        description: tool.mutates ? `${tool.description} [mutates state]` : tool.description,
        inputSchema: tool.inputSchema
      }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await callTool(name, args, { readOnly });
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (err) {
      // isError rather than a thrown exception: a tool failing is a result the
      // model should see and can react to, while a thrown error terminates the
      // call with a transport-level failure the model cannot reason about.
      return {
        content: [{ type: "text", text: `Error calling ${name}: ${err.message}` }],
        isError: true
      };
    }
  });

  return server;
}

export async function startMcpServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr. stdout is the protocol stream.
  console.error(`[mcp] tollpike ready on stdio — ${TOOL_COUNT} tools across ${SCOPE_COUNT} scopes`);
}

/**
 * Mount the HTTP and SSE transports on an Express app.
 *
 * Both are mounted behind whatever auth the app already applies to the path —
 * this function does not add its own, and the caller mounts it inside the
 * authenticated section. An unauthenticated MCP endpoint is a remote control
 * for the gateway's spend.
 *
 * `readOnly` accepts a boolean or a function returning one. The function form
 * is resolved per request, so a mode that depends on mutable state — such as
 * "read-only while no gateway key is set" — takes effect the moment that state
 * changes rather than at the next restart.
 */
export async function mountMcpHttp(app, { path: basePath = "/mcp", readOnly = false } = {}) {
  const resolveReadOnly = () => (typeof readOnly === "function" ? Boolean(readOnly()) : Boolean(readOnly));
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");

  // ---- Streamable HTTP ----
  //
  // Stateless: a new Server and transport per request, sessionIdGenerator
  // undefined. Session-stateful mode would need a session store and a way to
  // expire it, and every tool here is a single request/response — there is no
  // multi-turn state on the server to keep.
  app.post(basePath, async (req, res) => {
    try {
      const server = createMcpServer({ readOnly: resolveReadOnly() });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      // Closing the server with the response prevents an accumulation of live
      // Server objects, one per request, each holding its transport.
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[mcp/http] ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null
        });
      }
    }
  });

  app.get(basePath, (req, res) => {
    // GET on the Streamable HTTP endpoint is for a server-initiated stream,
    // which this server never opens. Answering 405 with the reason beats an
    // empty hang.
    res.status(405).json({
      error: "This endpoint accepts POST. Server-initiated streams are not used; GET /mcp/sse for the SSE transport."
    });
  });

  // ---- SSE (legacy two-endpoint transport) ----
  //
  // GET opens the event stream, POST /messages delivers client messages into it,
  // correlated by sessionId. This one IS stateful by design, so live transports
  // are tracked and removed on close.
  const sseTransports = new Map();

  app.get(`${basePath}/sse`, async (req, res) => {
    try {
      const transport = new SSEServerTransport(`${basePath}/messages`, res);
      sseTransports.set(transport.sessionId, transport);
      res.on("close", () => sseTransports.delete(transport.sessionId));
      const server = createMcpServer({ readOnly: resolveReadOnly() });
      await server.connect(transport);
    } catch (err) {
      console.error(`[mcp/sse] ${err.message}`);
      if (!res.headersSent) res.status(500).end();
    }
  });

  app.post(`${basePath}/messages`, async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = sseTransports.get(sessionId);
    if (!transport) {
      // A stale sessionId is the normal case after a gateway restart, and the
      // fix is "reopen the stream" rather than anything about the request body.
      return res.status(404).json({
        error: `No open SSE session "${sessionId}". Reconnect to GET ${basePath}/sse first.`
      });
    }
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (err) {
      console.error(`[mcp/sse] ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    }
  });

  return {
    transports: ["streamable-http", "sse"],
    endpoints: { http: basePath, sse: `${basePath}/sse`, sseMessages: `${basePath}/messages` },
    // The value AS RESOLVED NOW, for the startup banner. It is not a snapshot
    // the transports read from — they call resolveReadOnly() per request.
    readOnly: resolveReadOnly(),
    dynamicReadOnly: typeof readOnly === "function",
    tools: TOOL_COUNT,
    scopes: SCOPE_COUNT
  };
}

export function mcpStatus() {
  return {
    server: SERVER_INFO,
    tools: TOOL_COUNT,
    scopes: SCOPE_COUNT,
    mutatingTools: listTools().filter((t) => t.mutates).length,
    transports: {
      stdio: "node src/mcp/server.js",
      http: "POST /mcp",
      sse: "GET /mcp/sse + POST /mcp/messages"
    },
    scopeList: Object.entries(SCOPES).map(([name, scope]) => ({
      scope: name,
      description: scope.description,
      tools: Object.keys(scope.tools).length
    }))
  };
}

// Standalone stdio mode for a Claude Desktop / Claude Code config entry.
if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((err) => {
    console.error(`[mcp] failed to start: ${err.message}`);
    process.exit(1);
  });
}
