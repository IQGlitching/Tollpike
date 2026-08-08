// Cloud coding agents behind one interface.
//
// Codex, Cursor, Devin and Jules each expose a task API: create a task, watch
// it work, approve a plan, collect the result. The shapes differ enough that
// driving all four from one client means a small adapter each, which is what
// this file is.
//
// EVERY ENDPOINT HERE IS UNVERIFIED. Nothing in this file has been exercised
// against a live account — these are the documented shapes, and vendor task
// APIs move faster than their docs. `verified: false` is on every driver and
// on the status response, exactly as the provider price table carries
// pricingVerified. Treat a first successful call as the verification step, and
// do not build anything expensive on top of an unverified driver.
//
// The uniform surface is deliberately thin: createTask, getTask, listTasks,
// approvePlan, cancelTask. A capability a vendor does not have is reported as
// unsupported rather than emulated, because a fake approval step that returns
// success without approving anything is worse than a missing one.

import { requestJson } from "../providers/http.js";

const TIMEOUT_MS = 30_000;

// A capability the vendor does not expose. Returned rather than thrown so a
// caller iterating over drivers does not have to special-case each one.
const unsupported = (driver, capability) => ({
  ok: false,
  unsupported: true,
  reason: `${driver} has no ${capability} API in this integration`
});

function bearer(key) {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

// Task ids arrive from a URL path segment and get interpolated into a vendor
// endpoint that the operator's API key is about to be sent to. Concatenating
// them unchecked let `../../` climb to a different resource on that vendor's
// API, and a `?` or `#` rewrite the query or truncate the path — a request
// forgery aimed at the vendor rather than at this gateway, but signed with the
// operator's credential either way.
//
// Every vendor here uses opaque alphanumeric ids (resp_…, devin-…, a UUID), so
// constraining to that alphabet costs nothing real. Encoded on the way out as
// well as validated: the allowlist is what makes it safe, the encoding is what
// keeps it safe if the allowlist is ever widened.
const TASK_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function safeTaskId(id) {
  const value = typeof id === "string" ? id : "";
  if (!TASK_ID_PATTERN.test(value)) {
    throw Object.assign(
      new Error(
        `Invalid task id "${value.slice(0, 60)}" — expected up to 128 characters of A-Z, a-z, 0-9, dot, underscore or hyphen.`
      ),
      { status: 400 }
    );
  }
  return encodeURIComponent(value);
}

// Jules addresses sessions as `sessions/<id>` and its own responses hand the
// prefixed form back, so both spellings have to be accepted. The prefix is
// stripped, the remainder validated as an ordinary id, and the prefix re-added
// here — rather than trusting whatever followed "sessions/" in the input.
function safeJulesName(id) {
  const bare = typeof id === "string" && id.startsWith("sessions/") ? id.slice("sessions/".length) : id;
  return `sessions/${safeTaskId(bare)}`;
}

export const DRIVERS = {
  codex: {
    label: "Codex",
    description: "OpenAI's cloud coding agent, driven through the Responses API with tool use.",
    apiKeyEnv: "OPENAI_API_KEY",
    baseURL: "https://api.openai.com/v1",
    verified: false,
    unsupported: ["listTasks", "approvePlan"],
    // Codex has no separate task resource: a run IS a Responses call. Modelled
    // as create-and-poll over that rather than pretending a task API exists.
    async createTask({ baseURL, key, prompt, model = "gpt-5-codex", repo = null }) {
      const body = await requestJson(
        "codex",
        `${baseURL}/responses`,
        {
          method: "POST",
          headers: bearer(key),
          body: JSON.stringify({
            model,
            input: repo ? `Repository: ${repo}\n\n${prompt}` : prompt,
            store: true
          })
        },
        TIMEOUT_MS
      );
      return { ok: true, id: body.id, status: body.status || "queued", raw: body };
    },
    async getTask({ baseURL, key, id }) {
      const body = await requestJson("codex", `${baseURL}/responses/${safeTaskId(id)}`, { headers: bearer(key) }, TIMEOUT_MS);
      return {
        ok: true,
        id: body.id,
        status: body.status,
        output: (body.output || [])
          .flatMap((item) => item.content || [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text)
          .join("\n"),
        raw: body
      };
    },
    async cancelTask({ baseURL, key, id }) {
      const body = await requestJson(
        "codex",
        `${baseURL}/responses/${safeTaskId(id)}/cancel`,
        { method: "POST", headers: bearer(key) },
        TIMEOUT_MS
      );
      return { ok: true, id, status: body.status };
    },
    listTasks: () => unsupported("codex", "task list"),
    approvePlan: () => unsupported("codex", "plan approval")
  },

  cursor: {
    label: "Cursor",
    description: "Cursor background agents. Create an agent run against a repo and follow it.",
    apiKeyEnv: "CURSOR_API_KEY",
    baseURL: "https://api.cursor.com/v0",
    verified: false,
    unsupported: ["approvePlan"],
    async createTask({ baseURL, key, prompt, repo = null, model = null }) {
      const body = await requestJson(
        "cursor",
        `${baseURL}/agents`,
        {
          method: "POST",
          headers: bearer(key),
          body: JSON.stringify({
            prompt: { text: prompt },
            ...(repo ? { source: { repository: repo } } : {}),
            ...(model ? { model } : {})
          })
        },
        TIMEOUT_MS
      );
      return { ok: true, id: body.id, status: body.status || "queued", raw: body };
    },
    async getTask({ baseURL, key, id }) {
      const body = await requestJson("cursor", `${baseURL}/agents/${safeTaskId(id)}`, { headers: bearer(key) }, TIMEOUT_MS);
      return { ok: true, id: body.id, status: body.status, output: body.summary || "", raw: body };
    },
    async listTasks({ baseURL, key }) {
      const body = await requestJson("cursor", `${baseURL}/agents`, { headers: bearer(key) }, TIMEOUT_MS);
      return { ok: true, tasks: (body.agents || []).map((a) => ({ id: a.id, status: a.status, title: a.name || null })) };
    },
    async cancelTask({ baseURL, key, id }) {
      await requestJson("cursor", `${baseURL}/agents/${safeTaskId(id)}`, { method: "DELETE", headers: bearer(key) }, TIMEOUT_MS);
      return { ok: true, id, status: "cancelled" };
    },
    approvePlan: () => unsupported("cursor", "plan approval")
  },

  devin: {
    label: "Devin",
    description: "Cognition's Devin. Sessions with messages, and the one driver with real plan approval.",
    apiKeyEnv: "DEVIN_API_KEY",
    baseURL: "https://api.devin.ai/v1",
    verified: false,
    unsupported: ["cancelTask"],
    async createTask({ baseURL, key, prompt, repo = null }) {
      const body = await requestJson(
        "devin",
        `${baseURL}/sessions`,
        {
          method: "POST",
          headers: bearer(key),
          body: JSON.stringify({ prompt, ...(repo ? { snapshot_id: null, repo } : {}) })
        },
        TIMEOUT_MS
      );
      return { ok: true, id: body.session_id, status: body.status_enum || "queued", url: body.url || null, raw: body };
    },
    async getTask({ baseURL, key, id }) {
      const body = await requestJson("devin", `${baseURL}/session/${safeTaskId(id)}`, { headers: bearer(key) }, TIMEOUT_MS);
      return {
        ok: true,
        id: body.session_id,
        status: body.status_enum,
        output: body.structured_output ? JSON.stringify(body.structured_output) : "",
        raw: body
      };
    },
    async listTasks({ baseURL, key }) {
      const body = await requestJson("devin", `${baseURL}/sessions`, { headers: bearer(key) }, TIMEOUT_MS);
      return {
        ok: true,
        tasks: (body.sessions || []).map((s) => ({ id: s.session_id, status: s.status_enum, title: s.title || null }))
      };
    },
    // Approval is a message on the session, which is how Devin's own UI does it.
    async approvePlan({ baseURL, key, id, message = "Approved — proceed with the plan." }) {
      await requestJson(
        "devin",
        `${baseURL}/session/${safeTaskId(id)}/message`,
        { method: "POST", headers: bearer(key), body: JSON.stringify({ message }) },
        TIMEOUT_MS
      );
      return { ok: true, id, approved: true, via: "session message" };
    },
    cancelTask: () => unsupported("devin", "cancel")
  },

  jules: {
    label: "Jules",
    description: "Google's Jules. Sessions against a GitHub source, with an explicit plan approval step.",
    apiKeyEnv: "JULES_API_KEY",
    baseURL: "https://jules.googleapis.com/v1alpha",
    verified: false,
    unsupported: ["cancelTask"],
    async createTask({ baseURL, key, prompt, repo = null, branch = "main" }) {
      const body = await requestJson(
        "jules",
        `${baseURL}/sessions`,
        {
          method: "POST",
          headers: { "X-Goog-Api-Key": key, "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            ...(repo
              ? { sourceContext: { source: `sources/github/${repo}`, githubRepoContext: { startingBranch: branch } } }
              : {})
          })
        },
        TIMEOUT_MS
      );
      return { ok: true, id: body.name || body.id, status: body.state || "queued", raw: body };
    },
    async getTask({ baseURL, key, id }) {
      const body = await requestJson(
        "jules",
        `${baseURL}/${safeJulesName(id)}`,
        { headers: { "X-Goog-Api-Key": key } },
        TIMEOUT_MS
      );
      return { ok: true, id: body.name, status: body.state, output: body.title || "", raw: body };
    },
    async listTasks({ baseURL, key }) {
      const body = await requestJson("jules", `${baseURL}/sessions`, { headers: { "X-Goog-Api-Key": key } }, TIMEOUT_MS);
      return {
        ok: true,
        tasks: (body.sessions || []).map((s) => ({ id: s.name, status: s.state, title: s.title || null }))
      };
    },
    async approvePlan({ baseURL, key, id }) {
      const name = safeJulesName(id);
      await requestJson(
        "jules",
        `${baseURL}/${name}:approvePlan`,
        { method: "POST", headers: { "X-Goog-Api-Key": key }, body: "{}" },
        TIMEOUT_MS
      );
      return { ok: true, id: name, approved: true, via: "approvePlan" };
    },
    cancelTask: () => unsupported("jules", "cancel")
  }
};

export const DRIVER_IDS = Object.keys(DRIVERS);

function resolve(driverId) {
  const driver = DRIVERS[driverId];
  if (!driver) {
    return { ok: false, error: `unknown cloud agent "${driverId}" (use ${DRIVER_IDS.join(", ")})`, status: 400 };
  }
  const key = process.env[driver.apiKeyEnv];
  if (!key) {
    return { ok: false, error: `${driver.apiKeyEnv} is not set`, status: 400 };
  }
  return { ok: true, driver, key, baseURL: driver.baseURL };
}

// One call shape for all four. Errors come back as { ok: false } with a status
// so the HTTP layer can pass them through without knowing anything about which
// vendor failed.
async function invoke(driverId, capability, args = {}) {
  const resolved = resolve(driverId);
  if (!resolved.ok) return resolved;

  const { driver, key, baseURL } = resolved;
  const fn = driver[capability];
  if (typeof fn !== "function") return { ...unsupported(driverId, capability), status: 400 };

  try {
    const result = await fn({ ...args, baseURL, key });
    // A driver that returns { unsupported } is reporting a missing vendor
    // capability, not a failure — pass it through with a 400 rather than a 502.
    if (result.unsupported) return { ...result, status: 400 };
    return { ...result, driver: driverId, verified: driver.verified };
  } catch (err) {
    const status = err.status || 502;
    return {
      ok: false,
      driver: driverId,
      error: err.message,
      // A 400 is this gateway rejecting the caller's input before anything was
      // sent, so the "the vendor moved their API" hint would point at the wrong
      // thing entirely. It belongs only on failures that actually reached out.
      ...(status === 400
        ? {}
        : { hint: "This driver is unverified against a live account — the endpoint or payload shape may have moved." }),
      status
    };
  }
}

export const createTask = (driverId, args) => invoke(driverId, "createTask", args);
export const getTask = (driverId, id) => invoke(driverId, "getTask", { id });
export const listTasks = (driverId) => invoke(driverId, "listTasks", {});
export const approvePlan = (driverId, id, message) => invoke(driverId, "approvePlan", { id, message });
export const cancelTask = (driverId, id) => invoke(driverId, "cancelTask", { id });

export const CAPABILITIES = ["createTask", "getTask", "listTasks", "approvePlan", "cancelTask"];

export function cloudAgentStatus() {
  return {
    drivers: DRIVER_IDS.map((id) => {
      const driver = DRIVERS[id];
      // Declared on the driver rather than inferred from the function. Probing
      // by calling it is not safe (it would fire a real request) and inspecting
      // the source text is the kind of cleverness that breaks silently the
      // first time someone reformats the file.
      const missing = driver.unsupported || [];
      return {
        id,
        label: driver.label,
        description: driver.description,
        apiKeyEnv: driver.apiKeyEnv,
        hasKey: Boolean(process.env[driver.apiKeyEnv]),
        baseURL: driver.baseURL,
        verified: driver.verified,
        capabilities: CAPABILITIES.filter((c) => !missing.includes(c)),
        unsupported: missing
      };
    }),
    caveat:
      "No driver here has been exercised against a live account. Endpoint paths and payload shapes " +
      "follow vendor documentation and are marked verified: false until a real call succeeds."
  };
}
