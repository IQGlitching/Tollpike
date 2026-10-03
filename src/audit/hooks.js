// Claude Code hooks: the agent runtime reporting each action as it happens.
//
// Claude Code can POST every hook event to a URL (`"type": "http"` hooks), and
// Tollpike answers in Claude Code's own response format. That makes this the
// first capture point that sees an action before it runs, and the first that
// can stop one:
//
//   PreToolUse          tool.requested. A rule in block mode answers
//                       permissionDecision "deny"; in ask mode, "ask", which
//                       puts a permission prompt in front of the person.
//   PostToolUse(Failure) tool.executed, with the real result. A result rule in
//                       block mode (prompt injection in what came back)
//                       answers decision "block", so the model never reads it.
//   UserPromptSubmit    prompt.submitted. Block mode on a prompt rule (a
//                       credential pasted into a prompt) stops it being sent.
//   SessionStart/End    session lifecycle.
//
// Tollpike never answers "allow". That would skip the person's own permission
// prompt, and an audit layer may withhold permission but must never grant it.
// With no objection the response is an empty object and Claude Code carries on
// exactly as it would without the hook.
//
// Field names follow the Claude Code hooks reference. The executed-tool result
// is read from `tool_output` or `tool_response`, because both spellings have
// appeared in Claude Code releases and a hook that silently records nothing
// on one of them would be a gap nobody notices.

import { recordToolRequest, recordToolExecuted, recordPrompt, recordSession } from "./index.js";

const SOURCE = "claude-code";

function common(p) {
  return {
    source: SOURCE,
    session: p.session_id,
    subagent: p.agent_type || p.agent_id,
    cwd: p.cwd,
    toolUseId: p.tool_use_id,
    tool: p.tool_name
  };
}

function resultOf(p) {
  const out = p.tool_output ?? p.tool_response ?? (p.error !== undefined ? { error: p.error } : null);
  if (out && typeof out === "object" && !Array.isArray(out)) {
    const status = out.status === "error" || out.is_error === true || out.isError === true ? "error" : null;
    const text = out.output ?? out.stdout ?? out.content ?? out.error ?? out;
    return { status, text: [text, out.stderr].filter((x) => x !== undefined && x !== "").map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n") };
  }
  return { status: null, text: out };
}

/**
 * Handle one Claude Code hook payload. Returns { status, body }: the HTTP
 * status and the JSON Claude Code reads. Unknown events are acknowledged with
 * an empty object so a newer Claude Code never breaks on an older Tollpike.
 */
export function handleClaudeCodeHook(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.hook_event_name !== "string") {
    return { status: 400, body: { error: "Expected a Claude Code hook payload with hook_event_name." } };
  }
  const p = payload;
  switch (p.hook_event_name) {
    case "PreToolUse": {
      const r = recordToolRequest({ ...common(p), input: p.tool_input, permissionMode: p.permission_mode, canAsk: true });
      if (!r.decision) return { status: 200, body: {} };
      return {
        status: 200,
        body: {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: r.decision === "block" ? "deny" : "ask",
            permissionDecisionReason: r.reason
          }
        }
      };
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const { status, text } = resultOf(p);
      const r = recordToolExecuted({
        ...common(p),
        output: text,
        status: p.hook_event_name === "PostToolUseFailure" ? "error" : status || "success"
      });
      if (r.withhold && p.hook_event_name === "PostToolUse") {
        return { status: 200, body: { decision: "block", reason: r.reason } };
      }
      return { status: 200, body: {} };
    }
    case "UserPromptSubmit": {
      const r = recordPrompt({ ...common(p), prompt: p.prompt });
      return { status: 200, body: r.block ? { decision: "block", reason: r.reason } : {} };
    }
    case "SessionStart":
      recordSession("start", { ...common(p), detail: p.source });
      return { status: 200, body: {} };
    case "SessionEnd":
      recordSession("end", { ...common(p), detail: p.reason });
      return { status: 200, body: {} };
    default:
      return { status: 200, body: {} };
  }
}

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "SessionStart", "SessionEnd"];
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

/**
 * The settings.json fragment that wires Claude Code to this gateway.
 *
 * http (default): Claude Code POSTs each event itself. Nothing to install on
 *   the agent machine. A gateway that is down or slow is a non-blocking hook
 *   error to Claude Code, so the agent carries on unaudited (fail-open).
 * command: runs `tollpike hook claude-code`, which forwards the event and,
 *   with --fail-closed, refuses tool calls while the gateway is unreachable.
 *   Needs the tollpike CLI on the agent machine.
 *
 * The agent key is never written into the file: it is read from the
 * TOLLPIKE_AGENT_KEY environment variable at run time.
 */
export function claudeCodeHookConfig({ url = "http://127.0.0.1:20128", mode = "http", failClosed = false, timeout = 10 } = {}) {
  const endpoint = `${String(url).replace(/\/+$/, "")}/audit/hooks/claude-code`;
  const hook =
    mode === "command"
      ? { type: "command", command: `tollpike hook claude-code --url ${url}${failClosed ? " --fail-closed" : ""}`, timeout: timeout + 5 }
      : {
          type: "http",
          url: endpoint,
          headers: { Authorization: "Bearer $TOLLPIKE_AGENT_KEY" },
          allowedEnvVars: ["TOLLPIKE_AGENT_KEY"],
          timeout
        };
  const hooks = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [TOOL_EVENTS.has(event) ? { matcher: "*", hooks: [hook] } : { hooks: [hook] }];
  }
  return { hooks };
}
