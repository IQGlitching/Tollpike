import { providers, resolveExplicit, priceFor } from "../providers/registry.js";
import { callOpenAICompatible, streamOpenAICompatible } from "../providers/openaiCompatible.js";
import { ProviderError, readWithStallTimeout } from "../providers/http.js";
import { clientGone } from "../audit/context.js";
import { callAnthropic, streamAnthropic } from "../providers/anthropic.js";
import { callGemini, streamGemini } from "../providers/gemini.js";
import * as resilience from "./resilience.js";
import {
  recordUsage,
  getMonthlySpend,
  reserveSpend,
  estimateRequestCost
} from "../storage/costTracker.js";
import { getSettings } from "../storage/settings.js";
import { estimateTokens, promptTextOf } from "../providers/normalize.js";
import { recordFreeUsage } from "../storage/quotaTracker.js";
import {
  strategyContext,
  orderByStrategy,
  orderByCombo,
  resolveStrategy,
  listCombos,
  recordStrategyOutcome
} from "./strategies.js";
import { recordModelCall, recordModelFailure } from "../audit/index.js";

const ADAPTERS = {
  "openai-compatible": callOpenAICompatible,
  anthropic: callAnthropic,
  gemini: callGemini
};

const STREAM_ADAPTERS = {
  "openai-compatible": streamOpenAICompatible,
  anthropic: streamAnthropic,
  gemini: streamGemini
};

// Retry the same provider this many extra times on transient errors before
// falling through to the next candidate in the chain.
const MAX_RETRIES_PER_PROVIDER = 2;
const BASE_BACKOFF_MS = 250;

function overBudget(provider, budgetCapsUsd) {
  const cap = budgetCapsUsd[provider.id];
  if (cap === undefined || cap === null) return false;
  return getMonthlySpend(provider.id) >= cap;
}

// Build the ordered list of (provider, model) candidates for a request.
//
//   "auto"                  -> settings.defaultCombo, or priority order
//   "auto/<strategy>"       -> one of routing/strategies.js STRATEGIES
//   "combo/<name>"          -> a built-in or saved tiered combo
//   "provider/model", bare model -> single explicit candidate
//
// The ordering itself lives in routing/strategies.js. This function only
// decides WHICH ordering applies and attaches the tier metadata that makes
// `attempts[]` readable — knowing a call landed on tier 3 is the difference
// between "routing worked" and "everything I wanted was unavailable".
export function buildCandidates(modelString, request = null) {
  const settings = getSettings();

  const isAuto = modelString === "auto" || modelString.startsWith("auto/");
  const isCombo = modelString.startsWith("combo/");

  if (isAuto || isCombo) {
    const pool = providers.filter(
      (p) => p.models.length > 0 && !settings.disabledProviders.includes(p.id)
    );
    const ctx = strategyContext({ request, settings, pool });

    if (isCombo || (modelString === "auto" && settings.defaultCombo)) {
      const name = isCombo ? modelString.slice("combo/".length) : settings.defaultCombo;
      const combo = listCombos(settings.combos)[name];
      if (!combo) {
        throw Object.assign(
          new Error(
            `Unknown combo "${name}". Available: ${Object.keys(listCombos(settings.combos)).join(", ")}`
          ),
          { status: 400 }
        );
      }
      return orderByCombo(combo, pool, ctx).map(({ provider, tier, strategy }) => ({
        provider,
        model: provider.models[0],
        tier,
        strategy,
        combo: name
      }));
    }

    const requested = modelString === "auto" ? "priority" : modelString.slice("auto/".length);
    const strategy = resolveStrategy(requested);
    if (!strategy) {
      throw Object.assign(
        new Error(
          `Unknown routing strategy "${requested}". Use auto/<strategy> or combo/<name>; ` +
            "GET /api/panel/strategies lists both."
        ),
        { status: 400 }
      );
    }
    return orderByStrategy(strategy, pool, ctx).map((provider) => ({
      provider,
      model: provider.models[0],
      tier: 1,
      strategy
    }));
  }

  const explicit = resolveExplicit(modelString);
  if (!explicit) return [];

  // The provider exists but doesn't list this model. Surfaced as a distinct
  // 400 rather than being forwarded: passing an unlisted model through
  // meant the configured `models` array was documentation instead of an
  // allowlist, and spend was billed at the entry's cost table regardless of
  // which model actually answered.
  if (explicit.notAllowed) {
    throw Object.assign(
      new Error(
        `Model "${explicit.model}" is not listed for provider "${explicit.provider.id}". ` +
          `Configured models: ${explicit.provider.models.join(", ") || "(none)"}. ` +
          "Add it to config/providers.json, or set ALLOW_UNLISTED_MODELS=true to forward unlisted models."
      ),
      { status: 400 }
    );
  }

  return [explicit];
}

/**
 * Why this lane would be passed over, or null if it would be contacted.
 *
 * @param {{ claimProbe?: boolean }} options
 *   The routing gate claims a half-open probe slot as a side effect, which is
 *   correct when a request is about to be dispatched and wrong when something
 *   is only asking. `claimProbe: false` reads the same state without moving
 *   it, so the preview endpoint can answer the question without spending the
 *   one probe a recovering provider gets per cooldown window.
 */
export function skipReason(provider, settings, model, { claimProbe = true } = {}) {
  if (settings.disabledProviders.includes(provider.id)) return "disabled in control panel";
  if (!provider.available) return "no API key configured";
  const providerUp = claimProbe
    ? resilience.isProviderAvailable(provider.id)
    : resilience.canServe(provider.id);
  if (!providerUp) return "circuit open (provider)";
  if (model && !resilience.isModelAvailable(provider.id, model)) return "model locked out";
  if (overBudget(provider, settings.budgetCapsUsd)) return "monthly budget cap reached";
  // Every key for this provider cooling down is the connection layer
  // exhausting itself — distinct from the provider being down.
  if (!provider.connections.some((c) => resilience.isConnectionAvailable(provider.id, c.id))) {
    return "all connections cooling down";
  }
  return null;
}

// Pick the first key that isn't cooling down, so one bad key doesn't
// take the provider out of rotation.
function pickConnection(provider) {
  return provider.connections.find((c) => resilience.isConnectionAvailable(provider.id, c.id)) || null;
}

// `attempts[]` is echoed to the caller. It is genuinely useful for
// debugging, but the raw upstream error body can carry provider-side detail
// that a gateway client has no business seeing, so that stays in the log.
function publicAttempt(attempt) {
  if (!attempt.error) return attempt;
  const { error, ...rest } = attempt;
  return { ...rest, error: attempt.errorSummary || error };
}

export function publicAttempts(attempts = []) {
  return attempts.map(publicAttempt);
}

// When every provider that was tried refused the request itself (400, 413,
// 422), the request is what is wrong, and a 502 "all providers failed" told
// the caller to retry something that can never succeed. Their status is
// returned instead. Upstream bodies still stay out of the response.
const REQUEST_ERRORS = new Set([400, 413, 422]);
function allProvidersFailed(attempts, stream) {
  const tried = attempts.filter((a) => !a.skipped && !a.ok);
  const statuses = tried.map((a) => a.upstreamStatus);
  const error = new Error(`All candidate providers failed or were unavailable${stream ? " for streaming" : ""}`);
  error.status = 502;
  if (tried.length && statuses.every((st) => REQUEST_ERRORS.has(st))) {
    error.status = statuses[0];
    error.message = `Every provider tried rejected the request as invalid (HTTP ${statuses[0]}). Check the request: its parameters, size or model name.`;
  }
  error.attempts = attempts;
  return error;
}

function summarizeError(err) {
  if (err instanceof ProviderError) return `provider returned HTTP ${err.status}`;
  return err?.name === "AbortError" ? "request aborted" : "upstream request failed";
}

export async function routeChatCompletion(request) {
  const candidates = buildCandidates(request.model, request);
  const settings = getSettings();

  if (candidates.length === 0) {
    throw Object.assign(new Error(`No provider configured for model "${request.model}"`), {
      status: 400
    });
  }

  const attempts = [];

  for (const { provider, model, tier, strategy } of candidates) {
    const reason = skipReason(provider, settings, model);
    if (reason) {
      attempts.push({ provider: provider.id, tier, strategy, skipped: reason });
      continue;
    }

    const connection = pickConnection(provider);
    const adapter = ADAPTERS[provider.adapter];
    const startedAt = Date.now();

    // Hold an estimate against the monthly cap for the duration of the
    // call. Without it the cap only ever sees committed spend, so N
    // concurrent requests all read the same "not yet reached" total and
    // collectively overshoot it.
    const release = reserveSpend(
      provider.id,
      estimateRequestCost(request, priceFor(provider, model))
    );

    // Retry the SAME provider on transient failures (429 / 5xx / timeout)
    // before giving up on it and falling through to the next candidate.
    // A rate-limited provider is usually still the best choice a moment
    // later, so burning the whole fallback chain on one 429 wastes both
    // the preferred provider and, potentially, money on a pricier backup.
    let lastError = null;
    let succeeded = false;

    try {
      for (let attempt = 0; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
        try {
          const response = await adapter(
            provider,
            { ...request, resolvedModel: model },
            connection.key
          );
          resilience.recordSuccess(provider.id, connection.id, model);
          recordStrategyOutcome(provider.id, true);

          recordUsage({
            providerId: provider.id,
            model,
            usage: { ...response.usage, estimated: response.usage_source === "estimated" },
            latencyMs: Date.now() - startedAt,
            costPer1mTokens: priceFor(provider, model)
          });

          // Free-tier accounting. Counted from the same usage numbers the
          // ledger uses, so the two can never disagree about what was spent.
          recordFreeUsage(provider.id, {
            tokens: (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0)
          });

          succeeded = true;
          const finalAttempts = [
            ...attempts,
            {
              provider: provider.id,
              connection: connection.id,
              tier,
              strategy,
              ok: true,
              retries: attempt
            }
          ];
          // The audit record of this call: who asked, what the agent reported
          // back, what the model proposed. Never throws into the request.
          recordModelCall(request, response, { attempts: finalAttempts, provider: provider.id, model });
          return { response, attempts: finalAttempts };
        } catch (err) {
          // The client hung up: stop here. Moving on would bill another
          // provider for an answer nobody reads, and recording it as a failure
          // would mark a healthy provider down.
          if (clientGone()) throw err;
          lastError = err;
          // A failed call still consumed the vendor's rate-limit budget —
          // at essentially every provider a 429 or 500 counts against it. Not
          // recording it is how a quota counter drifts optimistic and the
          // drain strategies keep choosing a lane that has nothing left.
          recordFreeUsage(provider.id, { tokens: 0 });
          const retryable = err instanceof ProviderError ? err.retryable : false;
          if (!retryable || attempt === MAX_RETRIES_PER_PROVIDER) break;
          // Exponential backoff with jitter, so a burst of parallel requests
          // doesn't all retry in lockstep and re-trigger the same rate limit.
          const backoffMs = BASE_BACKOFF_MS * 2 ** attempt + Math.random() * 100;
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    } finally {
      release();
    }

    if (!succeeded) {
      // Classify the failure so we disable the smallest scope that
      // explains it, rather than blackholing the whole provider.
      const layer = resilience.classifyAndRecord(provider.id, connection.id, model, lastError);
      attempts.push({
        provider: provider.id,
        connection: connection.id,
        tier,
        strategy,
        error: lastError?.message,
        errorSummary: summarizeError(lastError),
        failureLayer: layer,
        upstreamStatus: lastError instanceof ProviderError ? lastError.status : undefined,
        retryable: lastError instanceof ProviderError ? lastError.retryable : false
      });
    }
  }

  const error = allProvidersFailed(attempts, false);
  recordModelFailure(request, error);
  throw error;
}

// Streaming path. Fallback works up through connection-open time: each
// candidate's adapter validates the HTTP response status before handing
// back an iterable, so a bad key or a 5xx moves to the next candidate
// with nothing written to the client yet. Once a stream is actually
// flowing, the gateway commits to that provider for the rest of the reply
// — switching providers mid-stream isn't something a client could sanely
// consume anyway (partial tokens from two different models).
export async function* routeChatCompletionStream(request) {
  const candidates = buildCandidates(request.model, request);
  const settings = getSettings();

  if (candidates.length === 0) {
    throw Object.assign(new Error(`No provider configured for model "${request.model}"`), {
      status: 400
    });
  }

  const attempts = [];

  for (const { provider, model, tier, strategy } of candidates) {
    const reason = skipReason(provider, settings, model);
    if (reason) {
      attempts.push({ provider: provider.id, tier, strategy, skipped: reason });
      continue;
    }

    const connection = pickConnection(provider);
    const streamAdapter = STREAM_ADAPTERS[provider.adapter];
    const startedAt = Date.now();

    // Same reservation the buffered path takes, and for the same reason. It
    // was missing here, so the monthly cap only ever saw committed spend for
    // streams: N concurrent streams each read the cap as "not yet reached"
    // and collectively overshot it. Streaming is the common case for a chat
    // client, so the cap was weakest exactly where it is leaned on hardest.
    const release = reserveSpend(
      provider.id,
      estimateRequestCost(request, priceFor(provider, model))
    );

    let upstream;
    try {
      upstream = await streamAdapter(provider, { ...request, resolvedModel: model }, connection.key);
    } catch (err) {
      // Nothing opened, so nothing will be billed for this candidate. Release
      // before moving on, or every failed candidate leaves its estimate held
      // against the cap for the rest of the month.
      release();
      if (clientGone()) throw err;
      const layer = resilience.classifyAndRecord(provider.id, connection.id, model, err);
      recordFreeUsage(provider.id, { tokens: 0 }); // the attempt reached the vendor
      attempts.push({
        provider: provider.id,
        connection: connection.id,
        tier,
        strategy,
        error: err.message,
        errorSummary: summarizeError(err),
        failureLayer: layer,
        upstreamStatus: err instanceof ProviderError ? err.status : undefined
      });
      continue; // try next candidate — connection never opened successfully
    }

    resilience.recordSuccess(provider.id, connection.id, model);
    recordStrategyOutcome(provider.id, true);
    yield { type: "provider-selected", provider: provider.id, model, tier, strategy };

    let completionText = "";
    // Populated if the provider volunteers real token counts mid-stream.
    let reportedUsage = null;
    // Tool calls arrive in fragments across deltas, keyed by index: the id and
    // name in the first, the arguments string spread over the rest. Stitched
    // back together here so the audit log records the call the agent received.
    const streamedCalls = [];
    let finishReason = null;
    const collectDelta = (choice) => {
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      for (const tc of choice.delta?.tool_calls || []) {
        const i = Number.isInteger(tc.index) ? tc.index : streamedCalls.length;
        const slot = (streamedCalls[i] ||= { id: null, type: "function", function: { name: "", arguments: "" } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") slot.function.arguments += tc.function.arguments;
      }
    };

    // A stream that dies partway used to skip recordUsage entirely, so the
    // tokens already generated and billed by the provider were invisible to
    // the monthly cap. Whatever was produced gets recorded either way.
    const commitUsage = () => {
      const estimated = !reportedUsage;
      const promptTokens = reportedUsage?.prompt_tokens ?? estimateTokens(promptTextOf(request));
      // Tool-call arguments are output too: an agent turn that is all tool call
      // used to be estimated at zero output tokens.
      const completionTokens = reportedUsage?.completion_tokens ?? estimateTokens(completionText + streamedCalls.filter(Boolean).map((c) => c.function.name + c.function.arguments).join(""));
      recordUsage({
        providerId: provider.id,
        model,
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          estimated
        },
        latencyMs: Date.now() - startedAt, // full stream duration, not time-to-first-byte
        costPer1mTokens: priceFor(provider, model)
      });
      recordFreeUsage(provider.id, { tokens: promptTokens + completionTokens });
      const calls = streamedCalls.filter(Boolean);
      recordModelCall(
        request,
        {
          provider: provider.id,
          model,
          choices: [{ message: { role: "assistant", content: completionText, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finishReason }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
          usage_source: estimated ? "estimated" : "reported"
        },
        { stream: true, provider: provider.id, model }
      );
    };

    try {
      if (provider.adapter === "openai-compatible") {
        // Raw byte passthrough — decode, split on SSE frames, extract text
        // for cost-tracking purposes, but forward the original frame as-is.
        const decoder = new TextDecoder();
        let buffer = "";
        // The terminating [DONE] is not forwarded: the route writes exactly
        // one itself, and passing the provider's through as well sent two.
        const isDone = (line) => /^data:\s*\[DONE\]\s*$/.test(line.replace(/\r$/, ""));
        const account = (line) => {
          if (!line.startsWith("data: ") || isDone(line)) return;
          try {
            const evt = JSON.parse(line.slice(6));
            completionText += evt.choices?.[0]?.delta?.content || "";
            collectDelta(evt.choices?.[0]);
            // Providers that volunteer a usage frame give exact numbers.
            if (evt.usage) {
              reportedUsage = {
                prompt_tokens: evt.usage.prompt_tokens,
                completion_tokens: evt.usage.completion_tokens
              };
            }
          } catch {
            /* ignore malformed frame */
          }
        };
        for await (const value of readWithStallTimeout(upstream.body, provider.id, upstream.controller)) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            account(line);
            if (!isDone(line)) yield { type: "raw-line", line };
          }
        }
        // A last frame with no newline after it was left in the buffer and
        // lost, often the one carrying the finish reason or the usage.
        buffer += decoder.decode();
        if (buffer.trim() && !isDone(buffer)) {
          account(buffer);
          yield { type: "raw-line", line: buffer };
          yield { type: "raw-line", line: "" };
        }
      } else {
        // Anthropic/Gemini adapters already yield normalized delta objects.
        for await (const chunk of upstream) {
          // Internal accounting frame — consumed here, never forwarded.
          if (chunk.__usage) {
            reportedUsage = chunk.__usage;
            continue;
          }
          completionText += chunk.choices?.[0]?.delta?.content || "";
          collectDelta(chunk.choices?.[0]);
          yield { type: "chunk", chunk };
        }
      }
    } finally {
      // Order matters and mirrors the buffered path: commit the real figure
      // first, then drop the estimate holding its place. Releasing first
      // would open a window where neither the estimate nor the actual cost
      // is counted against the cap. This finally also runs when the consumer
      // abandons the stream early, because closing a generator invokes it.
      commitUsage();
      release();
    }

    return; // stream complete, committed provider succeeded
  }

  const error = allProvidersFailed(attempts, true);
  recordModelFailure(request, error, { stream: true });
  throw error;
}
