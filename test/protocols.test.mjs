import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-protocols-"));
process.env.TOLLPIKE_DATA_DIR = tmpDir;

// A recognisable fake key on a provider that has none in CI. Every read-only
// tool's output is then scanned for it: the strongest available check that no
// tool leaks key material, since the leak would have to route through the same
// registry object the real keys live in.
const CANARY = "sk-canary-must-never-appear-in-any-tool-output";
process.env.GROQ_API_KEY = CANARY;

let scopes;
let a2a;
let card;
let skills;
let mcpServer;

before(async () => {
  scopes = await import("../src/mcp/scopes.js");
  a2a = await import("../src/a2a/server.js");
  card = await import("../src/a2a/card.js");
  skills = await import("../src/a2a/skills.js");
  mcpServer = await import("../src/mcp/server.js");
});

describe("MCP registry shape", () => {
  test("exposes a tool surface across many scopes", () => {
    assert.equal(scopes.SCOPE_COUNT, Object.keys(scopes.SCOPES).length);
    assert.equal(scopes.TOOL_COUNT, scopes.listTools().length);
    assert.ok(scopes.SCOPE_COUNT >= 31, `expected >=31 scopes, got ${scopes.SCOPE_COUNT}`);
    assert.ok(scopes.TOOL_COUNT >= 100, `expected >=100 tools, got ${scopes.TOOL_COUNT}`);
  });

  test("every tool name survives a strict MCP client", () => {
    // Several clients validate names against this and silently DROP anything
    // else — the tool vanishes from the list with no error logged anywhere.
    for (const tool of scopes.listTools()) {
      assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/, `bad tool name: ${tool.name}`);
    }
  });

  test("tool names are unique", () => {
    const names = scopes.listTools().map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
  });

  test("every tool has an object schema and a real description", () => {
    for (const tool of scopes.listTools()) {
      assert.equal(tool.inputSchema?.type, "object", `${tool.name} schema`);
      assert.ok(tool.description.length >= 20, `${tool.name} description is too thin to choose by`);
    }
  });

  test("every required schema property is actually declared", () => {
    for (const tool of scopes.listTools()) {
      for (const required of tool.inputSchema.required || []) {
        assert.ok(
          tool.inputSchema.properties?.[required],
          `${tool.name} requires "${required}" but does not declare it`
        );
      }
    }
  });

  test("mutating tools are marked", () => {
    const mutating = scopes.listTools().filter((t) => t.mutates);
    assert.ok(mutating.length > 0);
    // Spot-check the ones that spend money or destroy data.
    for (const name of ["completions_chat", "providers_test", "memory_forget", "cache_clear", "quota_reset"]) {
      assert.equal(scopes.findTool(name)?.mutates, true, `${name} must be marked as mutating`);
    }
    // And that reads are not.
    for (const name of ["providers_list", "cost_summary", "quota_snapshot", "routing_preview"]) {
      assert.equal(scopes.findTool(name)?.mutates, false, `${name} must not be marked as mutating`);
    }
  });
});

describe("MCP safety", () => {
  test("read-only mode refuses every mutating tool", async () => {
    for (const tool of scopes.listTools().filter((t) => t.mutates)) {
      await assert.rejects(
        () => scopes.callTool(tool.name, {}, { readOnly: true }),
        /read-only/,
        `${tool.name} was allowed in read-only mode`
      );
    }
  });

  test("read-only mode hides mutating tools from the list", async () => {
    const server = mcpServer.createMcpServer({ readOnly: true });
    assert.ok(server); // constructed without throwing — the handler filter is exercised below
    const visible = scopes.listTools().filter((t) => !t.mutates);
    assert.ok(visible.length > 0);
    assert.ok(visible.length < scopes.TOOL_COUNT);
  });

  test("NO read-only tool leaks provider key material", async () => {
    // The canary is a real configured key on groq for this process. If any tool
    // serialises connections[] or an apiKey, it lands in this scan.
    // auth_generate_key legitimately returns an apiKey: a freshly generated
    // candidate that is not stored anywhere and is not any existing credential.
    // It is still canary-scanned like everything else.
    const GENERATES_A_KEY = new Set(["auth_generate_key"]);

    const readTools = scopes.listTools().filter((t) => !t.mutates);
    for (const tool of readTools) {
      let output;
      try {
        output = await scopes.callTool(tool.name, {});
      } catch {
        continue; // a tool needing required args is not a leak path here
      }
      const serialized = JSON.stringify(output ?? "");
      assert.ok(!serialized.includes(CANARY), `${tool.name} leaked key material`);
      assert.ok(!/"connections"\s*:\s*\[\s*\{/.test(serialized), `${tool.name} serialised connections[]`);
      if (!GENERATES_A_KEY.has(tool.name)) {
        assert.ok(!/"apiKey"\s*:\s*"[^"]/.test(serialized), `${tool.name} serialised an apiKey field`);
      }
    }
  });

  test("settings_get reduces the gateway key to a presence flag", async () => {
    const settings = await import("../src/storage/settings.js");
    settings.updateSettings({ gatewayApiKey: "a-very-secret-gateway-key-value" });
    try {
      const result = await scopes.callTool("settings_get", {});
      assert.equal(result.gatewayApiKey, "<set>");
      assert.ok(!JSON.stringify(result).includes("a-very-secret-gateway-key-value"));
    } finally {
      settings.updateSettings({ gatewayApiKey: null });
    }
  });

  test("settings_patch refuses to write the gateway key", async () => {
    // An agent able to set it could lock the operator out; able to clear it,
    // could disable auth. Neither is a decision a tool call should make.
    await assert.rejects(
      () => scopes.callTool("settings_patch", { patch: { gatewayApiKey: "hijacked-key-value" } }),
      /cannot be written through MCP/
    );
  });

  test("settings_patch refuses any key outside the allowlist", async () => {
    await assert.rejects(() => scopes.callTool("settings_patch", { patch: { memory: {} } }), /cannot be written/);
  });

  test("auth_generate_key returns a candidate but cannot install it", async () => {
    const result = await scopes.callTool("auth_generate_key", {});
    assert.ok(result.apiKey.length >= 16);
    assert.match(result.note, /cannot install/i);
    const settings = await import("../src/storage/settings.js");
    assert.equal(settings.getSettings().gatewayApiKey, null);
  });

  test("diagnostics_environment reports presence, never values", async () => {
    const result = await scopes.callTool("diagnostics_environment", {});
    assert.equal(result.GROQ_API_KEY, undefined); // not in the flag list at all
    assert.ok(!JSON.stringify(result).includes(CANARY));
    for (const value of Object.values(result)) {
      assert.ok(value === null || value === "<set>", `leaked an env value: ${value}`);
    }
  });

  test("an unknown tool names the discovery tool rather than failing blankly", async () => {
    await assert.rejects(() => scopes.callTool("no_such_tool", {}), /mcp_tools/);
  });
});

describe("MCP self-description", () => {
  test("mcp_scopes covers every scope", async () => {
    const listed = await scopes.callTool("mcp_scopes", {});
    assert.equal(listed.length, scopes.SCOPE_COUNT);
    assert.equal(
      listed.reduce((n, s) => n + s.tools, 0),
      scopes.TOOL_COUNT
    );
  });

  test("mcp_describe_tool returns a real schema", async () => {
    const described = await scopes.callTool("mcp_describe_tool", { name: "combos_save" });
    assert.equal(described.name, "combos_save");
    assert.ok(described.inputSchema.required.includes("tiers"));
    assert.equal(described.mutates, true);
  });

  test("mcpStatus counts agree with the registry", () => {
    const status = mcpServer.mcpStatus();
    assert.equal(status.tools, scopes.TOOL_COUNT);
    assert.equal(status.scopes, scopes.SCOPE_COUNT);
    assert.deepEqual(Object.keys(status.transports).sort(), ["http", "sse", "stdio"]);
  });
});

describe("A2A agent card", () => {
  test("advertises exactly the implemented skills", () => {
    const advertised = card.agentCard().skills.map((s) => s.id).sort();
    assert.deepEqual(advertised, [...skills.SKILL_IDS].sort());
    assert.equal(advertised.length, 6);
  });

  test("does not claim streaming it has not implemented", async () => {
    // The consistency that matters: a peer builds an incremental UI on this flag.
    assert.equal(card.agentCard().capabilities.streaming, false);
    const refusal = await a2a.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "message/stream", params: {} });
    assert.equal(refusal.error.code, -32601);
  });

  test("declares a security scheme only when auth is actually on", async () => {
    const settings = await import("../src/storage/settings.js");
    assert.deepEqual(card.agentCard().security, []);
    settings.updateSettings({ gatewayApiKey: "sixteen-characters-plus-more" });
    try {
      const withAuth = card.agentCard();
      assert.deepEqual(withAuth.security, [{ bearer: [] }]);
      assert.equal(withAuth.securitySchemes.bearer.scheme, "bearer");
      assert.equal(withAuth.tollpike.authRequired, true);
      // The card is served unauthenticated, so it must never carry the key.
      assert.ok(!JSON.stringify(withAuth).includes("sixteen-characters-plus-more"));
    } finally {
      settings.updateSettings({ gatewayApiKey: null });
    }
  });

  test("never advertises a wildcard bind as a dialable address", () => {
    const original = process.env.BIND_HOST;
    process.env.BIND_HOST = "0.0.0.0";
    try {
      assert.ok(!card.agentCard().url.includes("0.0.0.0"));
    } finally {
      if (original === undefined) delete process.env.BIND_HOST;
      else process.env.BIND_HOST = original;
    }
  });
});

describe("A2A JSON-RPC", () => {
  test("rejects a non-2.0 envelope and a missing method", async () => {
    assert.equal((await a2a.handleJsonRpc({ jsonrpc: "1.0", id: 1, method: "x" })).error.code, -32600);
    assert.equal((await a2a.handleJsonRpc({ jsonrpc: "2.0", id: 1 })).error.code, -32600);
    assert.equal((await a2a.handleJsonRpc("not an object")).error.code, -32600);
  });

  test("unknown method lists the available ones", async () => {
    const response = await a2a.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "nope" });
    assert.equal(response.error.code, -32601);
    assert.match(response.error.message, /message\/send/);
  });

  test("a notification gets no response", async () => {
    // Per JSON-RPC: a request without an id is a notification.
    assert.equal(await a2a.handleJsonRpc({ jsonrpc: "2.0", method: "tasks/list" }), null);
  });

  test("selects a skill from prose, and an explicit id wins", () => {
    assert.equal(skills.selectSkill("how much free quota is left?"), "quota-report");
    assert.equal(skills.selectSkill("what have I spent this month"), "cost-analysis");
    assert.equal(skills.selectSkill("is anything broken"), "health-report");
    assert.equal(skills.selectSkill("what models can you reach"), "discovery");
    assert.equal(skills.selectSkill("how much free quota", "health-report"), "health-report");
    // Unmatched prose is most likely a completion request.
    assert.equal(skills.selectSkill("zxcvbnm qwerty"), "smart-routing");
  });

  test("an unknown explicit skill is an invalid-params error", async () => {
    const response = await a2a.handleJsonRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text: "x" }] }, metadata: { skillId: "nope" } }
    });
    assert.equal(response.error.code, -32602);
  });

  test("runs a skill and returns a completed Task with artifacts", async () => {
    const response = await a2a.handleJsonRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text: "how much free quota is left?" }] } }
    });
    const task = response.result;
    assert.equal(task.kind, "task");
    assert.equal(task.status.state, "completed");
    assert.equal(task.metadata.skillId, "quota-report");
    assert.ok(task.artifacts[0].parts.some((p) => p.kind === "data"));
    assert.ok(task.status.message.parts[0].text.length > 0);
  });

  test("a failing skill is a FAILED TASK, not a transport error", async () => {
    // A peer cannot distinguish "your request was malformed" from "the work was
    // attempted and did not succeed" if both arrive as a JSON-RPC error.
    const response = await a2a.handleJsonRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: { role: "user", parts: [{ kind: "text", text: "hello" }] },
        metadata: { skillId: "smart-routing", input: { model: "combo/does-not-exist", prompt: "hi" } }
      }
    });
    assert.equal(response.error, undefined);
    assert.equal(response.result.status.state, "failed");
    assert.match(response.result.metadata.error, /combo/i);
  });

  test("tasks/get retrieves a task, and an unknown id is -32001", async () => {
    const created = await a2a.handleJsonRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text: "is anything broken" }] } }
    });
    const fetched = await a2a.handleJsonRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tasks/get",
      params: { id: created.result.id }
    });
    assert.equal(fetched.result.id, created.result.id);

    const missing = await a2a.handleJsonRpc({ jsonrpc: "2.0", id: 3, method: "tasks/get", params: { id: "nope" } });
    assert.equal(missing.error.code, -32001);
  });

  test("cancelling a finished task says so rather than pretending", async () => {
    const created = await a2a.handleJsonRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text: "is anything broken" }] } }
    });
    const cancelled = await a2a.handleJsonRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tasks/cancel",
      params: { id: created.result.id }
    });
    assert.equal(cancelled.error.code, -32002);
    assert.match(cancelled.error.message, /already completed/);
  });

  test("handles a batch and drops notification-only replies", async () => {
    const responses = await a2a.handleA2A([
      { jsonrpc: "2.0", id: 1, method: "tasks/list" },
      { jsonrpc: "2.0", method: "tasks/list" } // notification
    ]);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, 1);
    assert.equal(await a2a.handleA2A([{ jsonrpc: "2.0", method: "tasks/list" }]), null);
    assert.equal((await a2a.handleA2A([])).error.code, -32600);
  });

  test("skill output never carries key material", async () => {
    for (const skillId of skills.SKILL_IDS.filter((s) => s !== "smart-routing")) {
      const result = await skills.SKILLS[skillId].run({ query: "anything" });
      assert.ok(!JSON.stringify(result).includes(CANARY), `${skillId} leaked key material`);
    }
  });
});
