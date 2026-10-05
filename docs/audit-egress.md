# Making the audit trail mandatory

Tollpike records every model call that goes through it. An agent that calls a
provider directly never goes through it, and leaves no record. Coverage is only
as strong as the rule that forces traffic through the gateway, and an auditor
will ask how that rule is enforced. This page covers the three controls that
together answer that question, strongest first.

## 1. Key custody: provider keys live only on the Tollpike host

This is the control that matters most, and it costs nothing.

- Provider API keys (OpenAI, Anthropic, Google and the rest) are stored only in
  the Tollpike host's credential file (`~/.tollpike/.env`, or the container's
  environment). Nobody else is issued one.
- Every agent gets a Tollpike agent key instead:

  ```bash
  tollpike agents add claude-code-laptop
  ```

  The key is printed once. From that moment the model endpoints refuse callers
  without a key, so an agent that skips identifying itself is turned away
  rather than recorded as anonymous.
- Revoking an agent is one command, takes effect immediately, and does not
  affect any other agent:

  ```bash
  tollpike agents revoke claude-code-laptop
  ```

With key custody in place, an agent cannot use the company's provider accounts
without Tollpike. What remains is someone using a personal account, which the
network control below closes.

## 2. Network: only the Tollpike host may reach provider APIs

Print the hostnames to block. The list comes from the provider registry, so it
grows when a provider is added:

```bash
tollpike audit egress-hosts           # host and the providers behind it
tollpike audit egress-hosts --plain   # one hostname per line, for an import
```

Then allow those hosts from the Tollpike host only, and deny them for every
other machine. Where to enforce it, in order of preference:

| Where | How | Notes |
|---|---|---|
| Egress proxy or secure web gateway | Domain (SNI) deny rule for the list, with an exception for the Tollpike host's address | The most robust option, and usually already deployed (Zscaler, Netskope, Squid, a cloud firewall with FQDN rules such as Azure Firewall or AWS Network Firewall). |
| Container network | Agents run on an `internal: true` network whose only route out is the Tollpike container | Strong for agents you deploy yourself. Example below. |
| DNS | Resolve the listed hosts only for the Tollpike host | Simple, but bypassable with hard-coded IPs or DNS over HTTPS. Use it alongside one of the above, not instead of them. |
| Host firewall | Per-machine rules | Weakest: most host firewalls match addresses, not hostnames, and provider addresses change. |

Container example: the agent can reach Tollpike and nothing else.

```yaml
services:
  tollpike:
    image: tollpike
    networks: [agents, outside]
  my-agent:
    image: my-agent
    environment:
      OPENAI_BASE_URL: http://tollpike:20128/v1
      OPENAI_API_KEY: ${AGENT_KEY}      # a tpa_ agent key, not a provider key
    networks: [agents]
networks:
  agents:
    internal: true                      # no route to the internet
  outside: {}
```

Bind Tollpike to an address the agents can reach (`BIND_HOST`). The control
panel always needs the operator key (created on first start), an agent key
never opens it, and other machines need a key for the model endpoints.

## 3. Detection: prove nothing went around it

Controls are tested, not assumed. Where blocking is not possible yet (a single
laptop that runs both Tollpike and its agents, or a machine you do not
administer), detection is the control: run an endpoint sensor so any agent
that reaches a provider directly is flagged. On Windows without Sysmon:

```bash
tollpike agents add laptop-sensor --sensor   # key into TOLLPIKE_SENSOR_KEY
tollpike endpoint connections                # polls every 60s, provider hosts only
```

See [audit-endpoint.md](audit-endpoint.md) for the other sensors. Then three
checks, worth running on a schedule and keeping as evidence:

1. **From an agent machine, a direct call must fail:**

   ```bash
   curl -sS -m 10 https://api.openai.com/v1/models -o /dev/null -w "%{http_code}\n"
   ```

   A connection error or a block page is a pass. Any HTTP status from OpenAI is
   a fail.
2. **Unattributed calls stay at zero.** `tollpike audit summary` reports
   `anonymousModelCalls`. Once agent keys are issued it should stay at 0.
3. **Provider usage matches the ledger.** Each provider's own usage dashboard
   should show no spend that Tollpike's ledger does not. Spend on the
   provider's side with no matching Tollpike record is traffic that went
   around the gateway.

## Pointing agents at Tollpike

Every agent takes its agent key where it would normally take a provider key.

| Agent | Setting |
|---|---|
| Claude Code | `ANTHROPIC_BASE_URL=http://<tollpike>:20128` and `ANTHROPIC_API_KEY=<agent key>` |
| OpenAI SDK, Codex, Aider and most others | `OPENAI_BASE_URL=http://<tollpike>:20128/v1` and `OPENAI_API_KEY=<agent key>` |
| Cursor, Cline, Continue | the custom OpenAI base URL in the tool's model settings, with the agent key as the API key |
| Ollama-only tools | point the Ollama host at `http://<tollpike>:20128` (Tollpike serves `/api/chat`) |

## What this does not cover

- Hosted agents that talk to their own vendor (ChatGPT, Claude.ai, Microsoft
  Copilot, Cursor's own backend when not using your key). Their traffic cannot
  be redirected. Use the vendor's enterprise audit log for those.
- Actions an agent takes on the machine without telling the model. The hook
  and MCP-proxy layers, and endpoint logs, cover those.
