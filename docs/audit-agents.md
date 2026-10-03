# Seeing and stopping agent actions before they run

The model connection (layer one) records what an agent tells the model. This
layer records what the agent actually does, from two capture points that see
each action before it executes:

| Capture point | Covers | Can stop an action |
|---|---|---|
| Claude Code hooks | every Claude Code tool call (shell, file edits, reads, web fetches, MCP tools), every prompt, every session | yes |
| MCP proxy | every MCP tool call from any agent that speaks MCP | yes |

Both write to the same hash-chained audit log, under the agent's own key, as
`tool.requested` (before it runs, with Tollpike's decision) and
`tool.executed` (after, with the real result).

## Rule modes

Each rule runs in one of four modes, set per rule:

| Mode | Effect |
|---|---|
| `observe` | the finding is recorded on the event |
| `flag` | recorded, and the event joins the review queue |
| `ask` | flagged, and Claude Code shows the person a permission prompt before the tool runs |
| `block` | flagged, and the action is refused before it runs |

`ask` and `block` only take effect where an action has not run yet: Claude Code
hooks and the MCP proxy. Over MCP there is no person to ask, so `ask` is
recorded as flagged and the event says so. On the model connection the tool
call has already reached the agent, so `ask` and `block` are recorded as
flags with a note that they could not be enforced. The record never claims a
block that did not happen.

Tollpike never answers "allow". It can withhold permission but never grants
it, so Claude Code's own permission rules always still apply.

Set modes through the panel API (validated and recorded as an admin change):

```bash
curl -X POST http://127.0.0.1:20128/api/panel/audit/settings \
  -H "content-type: application/json" \
  -d '{"ruleModes": {"shell.remote_exec": "block", "shell.destructive": "ask", "injection.in_tool_result": "block"}}'
```

Start with everything in `flag`, review what it catches for a week, then
promote the rules you trust. `tollpike audit` lists every rule and its mode.

## Claude Code

**1. Issue the agent a key** on the Tollpike host:

```bash
tollpike agents add claude-code-laptop
```

**2. Put the key in the agent machine's environment** as
`TOLLPIKE_AGENT_KEY`. The settings file references it by name and never
contains it.

**3. Generate the hooks block** and add it to a Claude Code settings file:

```bash
tollpike hook config --url http://<tollpike-host>:20128
```

It registers `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`UserPromptSubmit`, `SessionStart` and `SessionEnd` as HTTP hooks, so Claude
Code posts each event to Tollpike directly with nothing installed on the agent
machine.

Where to put it:

| File | Use it for |
|---|---|
| Claude Code's managed settings, deployed by IT | company-wide enforcement that individual users cannot remove. Recommended for an audit control. |
| `~/.claude/settings.json` | one person's machine |
| `.claude/settings.json` in a repository | everyone working on that repository |

Hooks from every settings file all run, so a project file cannot switch off a
managed one.

**Fail-open or fail-closed.** With HTTP hooks, a gateway that is down, slow or
erroring is a non-blocking hook error to Claude Code, and the agent carries on
unaudited. That is fail-open. For fail-closed, use the command form, which
needs the `tollpike` CLI on the agent machine:

```bash
tollpike hook config --url http://<tollpike-host>:20128 --command --fail-closed
```

With `--fail-closed`, a tool call or prompt is refused while Tollpike cannot
record it. Choose it where an unrecorded action is worse than a stopped one.

**What each event does**

| Claude Code event | Recorded as | What Tollpike can do |
|---|---|---|
| `PreToolUse` | `tool.requested`, with the permission mode | `block` answers deny with the reason, `ask` forces a permission prompt |
| `PostToolUse` | `tool.executed`, with the real result | a result rule in `block` (prompt injection in what came back) keeps the result from the model |
| `PostToolUseFailure` | `tool.executed`, status error | records only |
| `UserPromptSubmit` | `prompt.submitted`, stored as a hash | `block` on a prompt rule (a credential pasted in) stops it being sent |
| `SessionStart`, `SessionEnd` | `session.start`, `session.end` | records only |

A session running with permission checks bypassed is noted on every request
(`agent.unrestricted_mode`).

## MCP proxy

The agent connects to Tollpike instead of to each MCP server. Tollpike connects
to the real servers, lists their tools as `<server>__<tool>`, and checks every
call on the way down and back.

**1. List the downstream servers** in `mcp-proxy.json` in the data directory
(`tollpike where` prints it), or at the path in `TOLLPIKE_MCP_PROXY_CONFIG`:

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "docs": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  }
}
```

`${NAME}` is filled from the environment of the process running the proxy, so
tokens can stay in the environment instead of in the file. This file is
operator configuration: no agent and no MCP tool can write it. Check it with:

```bash
tollpike mcp-proxy --check
```

**2. Point the agent at the proxy**, in one of two ways:

- **stdio**, where the agent spawns its MCP servers. Replace the agent's MCP
  server entries with one:

  ```json
  { "mcpServers": { "tollpike": { "command": "tollpike", "args": ["mcp-proxy"], "env": { "TOLLPIKE_AGENT_KEY": "<agent key>" } } } }
  ```

  Once agent keys exist, the proxy refuses to start without a valid one. The
  downstream servers run on the agent's machine.
- **HTTP**, where the agent connects to a URL: `http://<tollpike-host>:20128/mcp-proxy`
  with the agent key as a Bearer token. The downstream servers run on the
  Tollpike host.

**What happens on a call**

- Before: `tool.requested`. A rule in `block` returns an error to the agent,
  and the downstream server never receives the call.
- After: `tool.executed` with status, duration and a redacted result. A
  result rule in `block` replaces the result with a notice, so the model never
  reads an injected page.
- A downstream server that exits is reconnected on the next call.

## Trust boundaries

- Hook events are reported by the agent's runtime. A compromised machine
  could send false ones, but only under its own agent key, so attribution
  holds. The MCP proxy executes the call itself, so its record is first-hand.
- With no agent keys and no operator key, the hook endpoint accepts anyone
  who can reach the port. Issue agent keys before relying on the record.
- Neither capture point covers activity on the machine outside an agent's
  tools. Endpoint logs are the next layer.
