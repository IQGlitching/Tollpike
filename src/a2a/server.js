// A2A server — JSON-RPC 2.0 over a single POST endpoint.
//
// Implements the methods a peer actually needs to get work done:
//
//   message/send   run a skill and return a completed Task
//   tasks/get      fetch a Task by id
//   tasks/cancel   cancel a Task
//   tasks/list     list recent Tasks (non-standard, useful, clearly marked)
//   agent/getAuthenticatedExtendedCard   the Agent Card
//
// `message/stream` is NOT implemented, and the Agent Card says
// `streaming: false` to match. Advertising a capability that returns one chunk
// at the end is worse than not advertising it: a peer builds an incremental UI
// around a promise the server does not keep. Tollpike streams fine over
// /v1/chat/completions — this is about not lying in a discovery document.
//
// JSON-RPC error codes follow the spec: -32700 parse, -32600 invalid request,
// -32601 method not found, -32602 invalid params, -32603 internal. A2A's own
// -32001 (task not found) is used where it applies.

import { randomUUID } from "node:crypto";
import { SKILLS, selectSkill } from "./skills.js";
import { agentCard } from "./card.js";

// Task store. In-process and bounded: A2A tasks here complete synchronously, so
// this exists for tasks/get after the fact rather than to track live work. A
// restart loses history, which is stated in the status response rather than
// implied to be durable.
const tasks = new Map();
const MAX_TASKS = 500;

function remember(task) {
  tasks.set(task.id, task);
  if (tasks.size > MAX_TASKS) {
    // Oldest first. Map preserves insertion order, so the first key is the
    // oldest task.
    tasks.delete(tasks.keys().next().value);
  }
}

function textFromMessage(message) {
  if (!message) return "";
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .filter((p) => p.kind === "text" || p.type === "text")
    .map((p) => p.text || "")
    .join("\n")
    .trim();
}

function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function nowIso() {
  return new Date().toISOString();
}

function taskShape({ id, contextId, state, skillId, message, artifacts = [], error = null }) {
  return {
    id,
    contextId,
    kind: "task",
    status: { state, timestamp: nowIso(), ...(message ? { message } : {}) },
    artifacts,
    metadata: { skillId, ...(error ? { error } : {}) },
    history: []
  };
}

function agentMessage(text) {
  return { role: "agent", parts: [{ kind: "text", text }], messageId: randomUUID(), kind: "message" };
}

async function handleMessageSend(id, params) {
  const message = params?.message;
  if (!message || typeof message !== "object") {
    return rpcError(id, -32602, "params.message is required");
  }

  const text = textFromMessage(message);
  const structured = params.metadata?.input || {};
  let skillId;
  try {
    skillId = selectSkill(text, params.metadata?.skillId || null);
  } catch (err) {
    return rpcError(id, err.code || -32602, err.message);
  }

  const skill = SKILLS[skillId];
  const taskId = randomUUID();
  const contextId = params.metadata?.contextId || randomUUID();

  // Structured input from metadata wins over the prose, and the prose fills the
  // skill's primary field when metadata does not name it. A peer that sends only
  // text still works; a peer that sends structured input is not second-guessed.
  const args = { ...structured };
  if (skillId === "smart-routing" && !args.prompt) args.prompt = text;
  if ((skillId === "memory-recall" || skillId === "discovery") && !args.query) args.query = text;

  try {
    const result = await skill.run(args);
    const task = taskShape({
      id: taskId,
      contextId,
      state: "completed",
      skillId,
      message: agentMessage(result.text || ""),
      artifacts: [
        {
          artifactId: randomUUID(),
          name: `${skillId}-result`,
          parts: [
            { kind: "text", text: result.text || "" },
            ...(result.data ? [{ kind: "data", data: result.data }] : [])
          ]
        }
      ]
    });
    remember(task);
    return rpcResult(id, task);
  } catch (err) {
    // A failed skill is a FAILED TASK, not a transport error. A peer that gets
    // a JSON-RPC error cannot tell "your request was malformed" from "the work
    // was attempted and did not succeed" — and those need different responses.
    const task = taskShape({
      id: taskId,
      contextId,
      state: "failed",
      skillId,
      message: agentMessage(`Skill "${skillId}" failed: ${err.message}`),
      error: err.message
    });
    remember(task);
    return rpcResult(id, task);
  }
}

function handleTasksGet(id, params) {
  const taskId = params?.id;
  if (!taskId) return rpcError(id, -32602, "params.id is required");
  const task = tasks.get(taskId);
  if (!task) {
    return rpcError(id, -32001, `Task "${taskId}" not found`, {
      note: "Task history is in-process and does not survive a gateway restart."
    });
  }
  return rpcResult(id, task);
}

function handleTasksCancel(id, params) {
  const taskId = params?.id;
  if (!taskId) return rpcError(id, -32602, "params.id is required");
  const task = tasks.get(taskId);
  if (!task) return rpcError(id, -32001, `Task "${taskId}" not found`);
  if (task.status.state === "completed" || task.status.state === "failed") {
    // Reported honestly rather than pretending the cancel took effect. Skills
    // here run synchronously, so a task a peer can see is already finished.
    return rpcError(id, -32002, `Task "${taskId}" is already ${task.status.state} and cannot be cancelled`);
  }
  task.status = { state: "canceled", timestamp: nowIso() };
  return rpcResult(id, task);
}

const METHODS = {
  "message/send": handleMessageSend,
  "message/stream": (id) =>
    rpcError(
      id,
      -32601,
      "message/stream is not implemented. The Agent Card reports streaming: false — use /v1/chat/completions for token streaming."
    ),
  "tasks/get": handleTasksGet,
  "tasks/cancel": handleTasksCancel,
  "tasks/list": (id) =>
    rpcResult(id, {
      // Non-standard extension, labelled as one.
      extension: "tollpike:tasks/list",
      tasks: [...tasks.values()]
        .slice(-50)
        .reverse()
        .map((t) => ({ id: t.id, state: t.status.state, skillId: t.metadata.skillId, timestamp: t.status.timestamp }))
    }),
  "agent/getAuthenticatedExtendedCard": (id) => rpcResult(id, agentCard())
};

export const A2A_METHODS = Object.keys(METHODS);

/**
 * Handle one JSON-RPC request object. Returns the response object, or null for
 * a notification (a request with no id, which per spec gets no reply).
 */
export async function handleJsonRpc(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return rpcError(null, -32600, "Invalid Request: expected a JSON-RPC 2.0 object");
  }
  if (body.jsonrpc !== "2.0") {
    return rpcError(body.id, -32600, 'Invalid Request: "jsonrpc" must be "2.0"');
  }
  if (typeof body.method !== "string") {
    return rpcError(body.id, -32600, 'Invalid Request: "method" must be a string');
  }

  const handler = METHODS[body.method];
  if (!handler) {
    return rpcError(body.id, -32601, `Method "${body.method}" not found. Available: ${A2A_METHODS.join(", ")}`);
  }

  const isNotification = body.id === undefined;

  try {
    const response = await handler(body.id, body.params);
    return isNotification ? null : response;
  } catch (err) {
    return isNotification ? null : rpcError(body.id, -32603, `Internal error: ${err.message}`);
  }
}

/**
 * Handle a batch or single request. JSON-RPC batches are an array; a batch of
 * only notifications gets no response body at all.
 */
export async function handleA2A(body) {
  if (Array.isArray(body)) {
    if (body.length === 0) return rpcError(null, -32600, "Invalid Request: empty batch");
    const responses = (await Promise.all(body.map(handleJsonRpc))).filter((r) => r !== null);
    return responses.length ? responses : null;
  }
  return handleJsonRpc(body);
}

export function a2aStatus() {
  return {
    protocolVersion: agentCard().protocolVersion,
    methods: A2A_METHODS,
    skills: agentCard().skills.map((s) => s.id),
    tasksTracked: tasks.size,
    streaming: false,
    endpoints: { jsonrpc: "/a2a", agentCard: "/.well-known/agent-card.json" },
    taskHistory: "in-process and bounded to 500 tasks; not durable across a restart"
  };
}

export function _resetTasks() {
  tasks.clear();
}
