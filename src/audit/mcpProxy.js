// MCP proxy: Tollpike in front of an agent's other MCP servers.
//
// The agent connects to Tollpike instead of to each MCP server. Tollpike
// connects downstream, lists every server's tools under one namespace
// (`<server>__<tool>`), and runs each call through the audit rules on its way
// down and its way back. That makes every MCP tool execution ground truth in
// the record, from any agent that speaks MCP, and lets a rule in block mode
// refuse a call before the downstream server ever sees it.
//
//   on the way down  tool.requested; block mode refuses the call
//   on the way back  tool.executed with the real result; a result rule in
//                    block mode (prompt injection in what came back) replaces
//                    the result with a notice, so the model never reads it
//
// Ask mode has no person to ask over MCP, so it is recorded as flagged and
// the event says so. Two transports to the agent: stdio (`tollpike
// mcp-proxy`, spawned by the agent) and HTTP (`/mcp-proxy` on the gateway).
//
// Configuration lives in a file the operator edits, never in anything an
// agent can write: mcp-proxy.json in the data directory, or the path in
// TOLLPIKE_MCP_PROXY_CONFIG. A downstream server's environment may reference
// the gateway's own variables as ${NAME}, so a token can stay in the
// environment instead of in the file.

import { baseChildEnv } from "../security/childEnv.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { dataDir } from "../paths.js";
import { recordToolRequest, recordToolExecuted } from "./index.js";
import { runWithContext } from "./context.js";

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const CALL_TIMEOUT_MS = Number(process.env.TOLLPIKE_MCP_PROXY_TIMEOUT_MS) || 120_000;
const CONNECT_TIMEOUT_MS = 30_000;

export function proxyConfigPath() {
  return process.env.TOLLPIKE_MCP_PROXY_CONFIG ? path.resolve(process.env.TOLLPIKE_MCP_PROXY_CONFIG) : path.join(dataDir, "mcp-proxy.json");
}

// ${NAME} expands from the gateway's environment; anything else is literal.
function expand(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
}

/** Read and validate the proxy configuration. Returns { ok, servers } or { ok:false, error }. */
export function loadProxyConfig(file = proxyConfigPath()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, servers: {}, file, missing: true };
    return { ok: false, error: `Cannot read ${file}: ${err.message}` };
  }
  const servers = {};
  for (const [name, s] of Object.entries(raw?.servers || {})) {
    if (!NAME_RE.test(name) || name.includes("__")) return { ok: false, error: `Server name "${name}" must be 1-32 letters, digits, '-' or '_' and must not contain "__".` };
    if (!s || typeof s !== "object") return { ok: false, error: `Server "${name}" must be an object.` };
    if (s.command) {
      if (typeof s.command !== "string") return { ok: false, error: `Server "${name}": command must be a string.` };
      if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string"))) return { ok: false, error: `Server "${name}": args must be an array of strings.` };
      servers[name] = { kind: "stdio", command: s.command, args: s.args || [], env: s.env || {}, cwd: s.cwd };
    } else if (s.url) {
      let u;
      try {
        u = new URL(s.url);
      } catch {
        return { ok: false, error: `Server "${name}": url is not a URL.` };
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: `Server "${name}": url must be http(s).` };
      servers[name] = { kind: "http", url: s.url, headers: s.headers || {} };
    } else {
      return { ok: false, error: `Server "${name}" needs either "command" (stdio) or "url" (HTTP).` };
    }
  }
  return { ok: true, servers, file };
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

// MCP clients drop tool names that are not ^[a-zA-Z0-9_-]{1,64}$, silently.
// Long names are shortened with a hash suffix so they stay unique and valid.
function exposedName(server, tool) {
  const clean = `${server}__${String(tool).replace(/[^A-Za-z0-9_-]/g, "_")}`;
  if (clean.length <= 64) return clean;
  const hash = crypto.createHash("sha256").update(`${server}/${tool}`).digest("hex").slice(0, 8);
  return `${clean.slice(0, 55)}_${hash}`;
}

function textOfResult(result) {
  if (!result) return "";
  const parts = (result.content || []).map((c) => (c?.type === "text" ? c.text : c?.type ? `[${c.type}]` : JSON.stringify(c)));
  if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n");
}

/**
 * Connections to every downstream server, opened on first use and reopened
 * after a failure. One hub serves every agent connection, so a stdio server
 * is spawned once, not once per request.
 */
export class ProxyHub {
  constructor(servers = {}) {
    this.servers = servers;
    this.clients = new Map(); // name -> { client, tools }
    this.routes = new Map(); // exposed name -> { server, tool }
    this.errors = {};
  }

  async connect(name) {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const cfg = this.servers[name];
    const client = new Client({ name: "tollpike-mcp-proxy", version: "1.0.0" });
    const transport =
      cfg.kind === "stdio"
        ? new StdioClientTransport({
            command: cfg.command,
            args: cfg.args,
            cwd: cfg.cwd,
            // A base environment plus what the server's own config names, never
            // the gateway's: that holds every provider key and TOLLPIKE_SECRET.
            // A server that needs a token gets it as "env": { "X": "${X}" }.
            env: { ...baseChildEnv(), ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, expand(v)])) },
            stderr: "pipe"
          })
        : new StreamableHTTPClientTransport(new URL(cfg.url), {
            requestInit: { headers: Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, expand(v)])) }
          });
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connecting to ${name}`);
      const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `listing ${name}'s tools`);
      const entry = { client, tools };
      this.clients.set(name, entry);
      delete this.errors[name];
      // A server that exits is reconnected on the next call rather than left
      // as a dead entry that fails every request until a restart.
      client.onclose = () => this.clients.delete(name);
      for (const t of tools) this.routes.set(exposedName(name, t.name), { server: name, tool: t.name });
      return entry;
    } catch (err) {
      this.errors[name] = String(err?.message || err).slice(0, 200);
      client.close().catch(() => {});
      throw err;
    }
  }

  async listTools() {
    const out = [];
    for (const name of Object.keys(this.servers)) {
      try {
        const { tools } = await this.connect(name);
        for (const t of tools) {
          out.push({
            name: exposedName(name, t.name),
            description: `[${name}] ${t.description || t.name}`,
            inputSchema: t.inputSchema || { type: "object", properties: {} }
          });
        }
      } catch {
        // An unreachable server drops out of the list; status() names it.
      }
    }
    return out;
  }

  async callTool(exposed, args = {}) {
    if (!this.routes.has(exposed)) await this.listTools();
    const route = this.routes.get(exposed);
    if (!route) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool "${exposed}".` }] };
    }
    const label = `mcp:${route.server}/${route.tool}`;
    const pre = recordToolRequest({ source: "mcp-proxy", tool: label, input: args, canAsk: false });
    if (pre.decision === "block") {
      return { isError: true, content: [{ type: "text", text: `Blocked before it ran. ${pre.reason}` }] };
    }

    const startedAt = Date.now();
    let result;
    try {
      const { client } = await this.connect(route.server);
      result = await withTimeout(client.callTool({ name: route.tool, arguments: args }), CALL_TIMEOUT_MS, `${label}`);
    } catch (err) {
      const message = String(err?.message || err).slice(0, 500);
      recordToolExecuted({ source: "mcp-proxy", tool: label, output: message, status: "error", durationMs: Date.now() - startedAt });
      return { isError: true, content: [{ type: "text", text: `${label} failed: ${message}` }] };
    }

    const post = recordToolExecuted({
      source: "mcp-proxy",
      tool: label,
      output: textOfResult(result),
      canWithhold: true,
      status: result?.isError ? "error" : "success",
      durationMs: Date.now() - startedAt
    });
    if (post.withhold) return { isError: true, content: [{ type: "text", text: post.reason }] };
    return result;
  }

  status() {
    return Object.entries(this.servers).map(([name, s]) => ({
      name,
      kind: s.kind,
      target: s.kind === "stdio" ? s.command : new URL(s.url).origin,
      connected: this.clients.has(name),
      tools: this.clients.get(name)?.tools.length ?? null,
      error: this.errors[name] || null
    }));
  }

  async close() {
    for (const { client } of this.clients.values()) await client.close().catch(() => {});
    this.clients.clear();
  }
}

/** An MCP Server facing the agent, backed by a hub. */
//
// `context` supplies the caller's identity when there is no HTTP request to
// carry it (the stdio transport): each call then runs inside it, so the
// events it produces name the agent.
export function createProxyServer(hub, { context = null } = {}) {
  const server = new Server({ name: "tollpike-mcp-proxy", version: "1.0.0" }, { capabilities: { tools: {} } });
  const scoped = (fn) => (context ? runWithContext({ ...context, requestId: crypto.randomUUID() }, fn) : fn());
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await hub.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    scoped(() => hub.callTool(request.params.name, request.params.arguments || {}))
  );
  return server;
}

let sharedHub = null;
let sharedStamp = null;

/** The gateway's hub, rebuilt when the config file changes. */
export function gatewayHub() {
  const file = proxyConfigPath();
  let stamp = "none";
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    // no config: an empty hub
  }
  if (sharedHub && stamp === sharedStamp) return sharedHub;
  const cfg = loadProxyConfig(file);
  if (sharedHub) sharedHub.close().catch(() => {});
  sharedHub = new ProxyHub(cfg.ok ? cfg.servers : {});
  sharedHub.configError = cfg.ok ? null : cfg.error;
  sharedStamp = stamp;
  return sharedHub;
}
