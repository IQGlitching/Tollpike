# Endpoint telemetry: what agents did on the machine

Hooks and the MCP proxy record what an agent reports. Endpoint telemetry
records what actually ran on the machine, from the operating system's own
sensors, and checks the two against each other. This layer answers two
questions an auditor will ask:

1. **Did an agent do anything nobody recorded?** Every process in an agent's
   process tree is matched to the audited action that explains it. A process
   no recorded action accounts for is flagged
   (`endpoint.unexplained_agent_activity`): either the agent did something
   without telling anyone, or its hooks are not wired.
2. **Did anything reach a model provider around the gateway?** A connection
   or DNS lookup to a provider host from anywhere but the gateway is flagged
   (`endpoint.direct_provider_access`). This is the detective check behind
   [audit-egress.md](audit-egress.md).

Tollpike reads what existing sensors already write. It is not an EDR and does
not try to be one.

## What is kept

Sensors emit far more than an audit trail should hold. Almost everything is
counted and dropped. What reaches the hash-chained log:

| Event | Kept when |
|---|---|
| `endpoint.process` | the process is in an agent's tree. A runtime's own helpers (Electron helper processes, ripgrep, read-only `git` queries) are counted, not kept. |
| `endpoint.file` | file activity in an agent's tree matches a rule (keys, credentials, system account files) |
| `endpoint.network` | a model provider is reached from anywhere but the gateway, or an agent's tree reaches a domain outside the allowlist. One record per host, program and destination per hour. |
| `endpoint.sensor` | hourly heartbeat per sensor with counts, so the record shows monitoring was running |

Command lines are stored redacted, with a SHA-256 of the original.

## Agent runtimes

A process belongs to an agent when an ancestor is an agent runtime. Recognised
out of the box: Claude Code and the Claude desktop app, Codex, Cursor,
Windsurf, Gemini CLI, Aider, opencode and goose. Add others through the
`agentProcesses` audit setting, as regular expressions over the executable
path or command line:

```bash
curl -X POST http://127.0.0.1:20128/api/panel/audit/settings \
  -H "content-type: application/json" \
  -d '{"agentProcesses": [{"name": "my-agent", "commandLine": "my_agent\\.py"}]}'
```

The gateway's own provider traffic is never a bypass. The gateway host is
always exempt; add other gateway hosts with the `gatewayHosts` setting.

## Setup

**1. Issue a sensor key** on the Tollpike host. A sensor key can submit
telemetry and nothing else, and an agent key cannot submit telemetry, so an
agent can never report on itself:

```bash
tollpike agents add laptop-sensor --sensor
```

**2. On each machine that runs agents**, set `TOLLPIKE_SENSOR_KEY` and
`TOLLPIKE_URL`, then start the collector for its sensor:

| Machine | Sensor | Collector |
|---|---|---|
| Windows | [Sysmon](https://learn.microsoft.com/sysinternals/downloads/sysmon) with process (1), network (3), file create (11), DNS (22) and file delete (23, 26) events enabled | `tollpike endpoint sysmon`, from an elevated session (the Sysmon log needs administrator rights) |
| Windows, without Sysmon | Built in: the TCP connection table and the DNS client cache | `tollpike endpoint connections`, no administrator rights. Detects provider connections only (see below) |
| Linux | auditd with execve and file-watch rules | `tollpike endpoint tail /var/log/audit/audit.log --format auditd` (as root) |
| Linux or macOS | osquery with `process_events`, `socket_events`, `file_events` | `tollpike endpoint tail /var/log/osquery/osqueryd.results.log --format osquery` |
| Kubernetes or Linux | Falco (eBPF) with JSON output to a file | `tollpike endpoint tail /var/log/falco.json --format falco` |

Each collector sends a process snapshot when it starts, so agent sessions that
were already running are recognised. It then ships new events as they arrive,
remembering its position across restarts. Run it as a service so it survives
reboots.

**No Sysmon? Provider connections only.** On a Windows machine where
installing Sysmon is not an option (a managed laptop, for example),
`tollpike endpoint connections` polls the open TCP connections every 60
seconds (`--interval` to change it), maps each remote address back to a
hostname through the DNS client cache, and sends only the connections to the
provider hosts from `tollpike audit egress-hosts`, together with a process
snapshot so each one is tied to its program. The rest of the machine's
traffic never leaves it. It feeds the same rule as Sysmon's network events:
an agent process reaching a provider around the gateway is flagged
`endpoint.direct_provider_access` (high), at most once an hour per program
and provider. On the gateway's own host only agent process trees count, so a
browser on that machine is not flagged. `--once` runs a single pass.

**Already shipping logs elsewhere?** Point any shipper (Fluent Bit, Vector,
Winlogbeat via an HTTP output) at
`POST /audit/endpoint/events?format=<sysmon|auditd|osquery|falco|native>&host=<name>`
with the sensor key as a Bearer token. JSON, NDJSON, Sysmon XML and raw auditd
text are all accepted. For a one-off file:

```bash
tollpike endpoint send --format auditd --host build-01 audit.log
```

## Matching processes to actions

The correlator keeps the last 15 minutes of audited actions from every
capture point: Claude Code hooks, the MCP proxy and the model connection. A
process is explained when its command line contains a recorded command, or is
a piece of one (a shell running `cd repo && rm -rf build` explains the `rm` it
spawns). This holds within five minutes before and ten seconds after the
process starts. Children inherit their parent's explanation. The explained
process carries a link to the audited event, and the agent identity from it.

Clocks matter: the window assumes the agent machine and the gateway agree on
the time to within seconds. Keep NTP running on both.

## Limits

- **Snapshots cannot see processes that already exited.** A process whose
  parent was never seen cannot be placed in a tree. It is counted as
  `orphaned` in every batch result and heartbeat rather than silently
  dropped. A live event stream (Sysmon, auditd) records each process as it
  starts and does not have this gap. Snapshots only fill in sessions that were
  already running when the collector started.
- **The process table is in memory.** After a gateway restart, ancestry is
  rebuilt from the next snapshot and the live stream.
- **Matching is textual.** An agent that builds a command dynamically (writes
  a script, then runs it) is matched on what it ran, so the script's own child
  processes appear as unexplained unless their parent was explained. That is
  the behaviour you want to see flagged.
- **Coverage is per machine.** A machine with no sensor contributes nothing to
  this layer, and the audit status says so.
- **`endpoint connections` sees what is open when it polls.** A connection
  that opens and closes between two polls is missed, as is one whose DNS entry
  has already expired from the cache. An address a CDN shares between several
  sites is attributed to whichever provider name the cache holds. It detects;
  it does not block.
