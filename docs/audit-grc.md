# Sending audit evidence to Vanta and Drata

Tollpike pushes its AI agent audit evidence into the compliance platform
where your ISO 27001, ISO 42001 or SOC 2 programme already runs. An auditor then sees it
next to the rest of your controls, as a live test and as attached evidence,
without anyone exporting files by hand.

## What is sent

| | What | Where it shows |
|---|---|---|
| **Tests** | Seven pass/fail signals computed from the audit record (below) | a Custom Test on your dashboard, green or red |
| **Evidence** | The evidence pack for the last 30 days, as a PDF (and the JSON, for Drata) | attached to the evidence slot or controls you choose |
| **Accounts** | The agent and sensor key register (names, kinds, created and revoked dates) | access reviews (Vanta) or a monitored dataset (Drata) |

Only summaries leave Tollpike: pass or fail with a one-line reason, the
evidence pack (already redacted and hashed), and key names and dates. Never
raw prompts, tool arguments or keys. Every push, successful or not, is itself
recorded in the audit chain as `grc.push`. A failed push is flagged for review.

### The seven tests

| Test | Passes when | ISO 27001 · SOC 2 | ISO 42001 | EU AI Act | NIST AI RMF | OWASP LLM | OWASP Agentic |
|---|---|---|---|---|---|---|---|
| `audit.chain_intact` | the hash chain verifies and the anchor agrees | 8.15, 5.28 · CC7.2 | A.6.2.8 | Art. 12, 19, 26(6) | MEASURE 2.8 | | |
| `audit.chain_keyed` | the chain is keyed with `TOLLPIKE_SECRET` | 8.15 · CC7.2 | A.6.2.8 | Art. 12 | MEASURE 2.8 | | |
| `audit.agents_attributed` | every model call in the last 7 days carried an agent key | 5.16, 8.15 · CC6.1 | A.6.2.8, A.3.2 | Art. 12 | MEASURE 2.8 | | ASI03, ASI10 |
| `audit.review_backlog` | no flagged event has waited longer than `grcReviewDays` (default 7) | 5.25 · CC7.3, CC7.4 | A.6.2.6 | Art. 14, 26(2) | MANAGE 4.3, MAP 3.5 | | |
| `audit.preexecution` | Claude Code hooks or the MCP proxy reported in the last 7 days | 8.16, 8.18 · CC6.8 | A.9.2, A.9.4 | Art. 14 | MANAGE 2.4, MAP 3.5 | LLM06, LLM05 | ASI02, ASI05 |
| `audit.egress_enforced` | endpoint sensors saw no provider connection bypassing the gateway | 8.20, 5.23 · CC6.6 | A.9.4, A.10.3 | Art. 12, 26(5) | GOVERN 1.6, MEASURE 2.8 | LLM10 | ASI10 |
| `audit.vendor_collection` | every enabled vendor log connector pulled within 48 hours | 5.23, 8.15 · CC7.2 | A.10.3, A.6.2.8 | Art. 26(5), 12 | MANAGE 3.1, GOVERN 6.1 | LLM03 | ASI04 |

A test with nothing to judge, for example no endpoint sensors or no vendor
connectors, reports **not applicable** instead of passing. A green light with
no data behind it is what an auditor would call misleading. See the current
results any time:

```bash
tollpike audit grc
```

## The one step neither platform lets an API do

Neither Vanta nor Drata has an API to create a test or set its result. So
Tollpike sends each signal as a data record, and you create the test once in
the platform's UI with this rule:

```
passing = true   OR   applicable = false
```

After that, each push updates the records and the platform re-evaluates the
test on its own schedule.

## Vanta

```bash
tollpike audit grc setup vanta     # prints these steps, with the schema to paste
```

1. **Settings › Developer Console › Create › Build Integrations › Private.**
   Put the client id and secret in the gateway's environment as
   `VANTA_CLIENT_ID` and `VANTA_CLIENT_SECRET`.
2. In that app's **Resources** tab, add a **Custom Resource** for the tests
   with the schema the setup command prints (flat fields: `signalId`,
   `status`, `passing`, `applicable`, `detail`, `controls`, `measuredAt`).
   Copy its Resource ID.
3. Optional: add a **User Account** resource, so agent keys appear in access
   reviews. Agents have no email, so each is sent as
   `<agent id>@agents.tollpike.invalid`. That domain can never be delivered
   to, and the role description marks each one as non-human.
4. Optional, for evidence uploads: document uploads are a different app type
   in Vanta. Create a **Manage Vanta** app and set
   `VANTA_MANAGE_CLIENT_ID` and `VANTA_MANAGE_CLIENT_SECRET`, then pick the
   evidence document the pack should go to.
5. Give Tollpike the ids, then push once:

   ```bash
   curl -X POST http://127.0.0.1:20128/api/panel/audit/settings -H "content-type: application/json" \
     -d '{"grc": {"vanta": {"enabled": true, "testsResourceId": "<id>", "accountsResourceId": "<id>", "documentId": "<id>"}}}'
   tollpike audit grc push vanta
   ```

6. **Tests › Create custom test**, choose the Tollpike integration and the
   test resource, set the rule above, and map it to your logging and
   monitoring controls. If you run ISO 42001 in Vanta, map it to A.6.2.8 and
   A.6.2.6 as well.

Vanta notes that Custom Tests may need a plan upgrade or add-on, and that
access reviews may need Access Management. Vanta allows one live token per
app, so do not point two gateways at the same app.

## Drata

```bash
tollpike audit grc setup drata
```

1. **Settings › API Keys › Create API Key**, with Custom Connections Data
   (create and update) and Evidence Library: Create Evidence. Set it as
   `DRATA_API_KEY`.
2. Create a **custom connection** for the tests, with record fields `id`,
   `name` (the display key), `status`, `passing`, `applicable`, `detail`,
   `controls`, `measuredAt`. Note the connection id and its resource id
   (`customResources[0].id`). Custom Connections need Drata's Advanced or
   Enterprise plan; without it Tollpike reports Drata's 402 plainly.
3. Optional: a second connection for the agent register, with fields `id`,
   `name`, `kind`, `active`, `createdAt`, `revokedAt`, `human`.
4. Give Tollpike the ids and the controls to link the evidence to, then push:

   ```bash
   curl -X POST http://127.0.0.1:20128/api/panel/audit/settings -H "content-type: application/json" \
     -d '{"grc": {"drata": {"enabled": true, "workspaceId": "<id>", "testsConnectionId": "<id>", "testsResourceId": "<id>", "evidenceControlCodes": "DCF-37,DCF-38"}}}'
   tollpike audit grc push drata
   ```

5. **Monitoring › Create test › Custom**, provider Tollpike, condition as
   above. Publish it and map it to your controls, including ISO 42001 A.6.2.8
   and A.6.2.6 if you run that framework in Drata.

Each push replaces the test and agent datasets atomically through a Drata
session. The evidence item is created on the first push; later pushes add a
new artifact version to it, so the monthly history stays in Drata. EU and APAC
tenants set `"region": "eu"` or `"apac"`.

## Schedule and status

Enabled platforms are pushed every 24 hours (`intervalHours` from 1 to 744).
The Audit page in the control panel shows the seven tests, each platform's
status, and **Push now** and schedule controls.

## How this was built

Each connector names the documentation it follows and the date it was checked
(2026-10-03). Vanta: developer.vanta.com and its Manage Vanta and Build
Integrations OpenAPI specs. Drata: the developers.drata.com V2 OpenAPI spec
and help articles. The tests run both against a mock of the documented
requests and responses.

**Neither connector has been run against a live account yet.** Treat the
first push as the verification step and check its `grc.push` record.

Points the documentation leaves open, handled conservatively:

- **Vanta:** the date format of `effectiveAtDate` is not specified (Tollpike
  sends `YYYY-MM-DD`). Two response shapes are documented for resource syncs,
  and both are handled.
- **Drata:** file size limits are not documented. The evidence PDF is small,
  typically under 100 KB.

If you test against a work Vanta or Drata tenant, check with whoever owns it
first. Pushing evidence into a company's compliance workspace is their call.
