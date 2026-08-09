import { providers, resolveExplicit, priceFor } from "../providers/registry.js";
import { callOpenAICompatible, streamOpenAICompatible } from "../providers/openaiCompatible.js";
import { ProviderError, readWithStallTimeout } from "../providers/http.js";
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

function skipReason(provider, settings, model) {
  if (settings.disabledProviders.includes(provider.id)) return "disabled in control panel";
  if (!provider.available) return "no API key configured";
  if (!resilience.isProviderAvailable(provider.id)) return "circuit open (provider)";
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
          return {
            response,
            attempts: [
              ...attempts,
              {
                provider: provider.id,
                connection: connection.id,
                tier,
                strategy,
                ok: true,
                retries: attempt
              }
            ]
          };
        } catch (err) {
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
        retryable: lastError instanceof ProviderError ? lastError.retryable : false
      });
    }
  }

  const error = new Error("All candidate providers failed or were unavailable");
  error.status = 502;
  error.attempts = attempts;
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
      const layer = resilience.classifyAndRecord(provider.id, connection.id, model, err);
      recordFreeUsage(provider.id, { tokens: 0 }); // the attempt reached the vendor
      attempts.push({
        provider: provider.id,
        connection: connection.id,
        tier,
        strategy,
        error: err.message,
        errorSummary: summarizeError(err),
        failureLayer: layer
      });
      continue; // try next candidate — connection never opened successfully
    }

    resilience.recordSuccess(provider.id, connection.id, model);
    recordStrategyOutcome(provider.id, true);
    yield { type: "provider-selected", provider: provider.id, model, tier, strategy };

    let completionText = "";
    // Populated if the provider volunteers real token counts mid-stream.
    let reportedUsage = null;

    // A stream that dies partway used to skip recordUsage entirely, so the
    // tokens already generated and billed by the provider were invisible to
    // the monthly cap. Whatever was produced gets recorded either way.
    const commitUsage = () => {
      const estimated = !reportedUsage;
      const promptTokens = reportedUsage?.prompt_tokens ?? estimateTokens(promptTextOf(request));
      const completionTokens = reportedUsage?.completion_tokens ?? estimateTokens(completionText);
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
    };

    try {
      if (provider.adapter === "openai-compatible") {
        // Raw byte passthrough — decode, split on SSE frames, extract text
        // for cost-tracking purposes, but forward the original frame as-is.
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const value of readWithStallTimeout(upstream.body, provider.id, upstream.controller)) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            if (line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]") {
              try {
                const evt = JSON.parse(line.slice(6));
                completionText += evt.choices?.[0]?.delta?.content || "";
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
            }
            yield { type: "raw-line", line };
          }
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

  const error = new Error("All candidate providers failed or were unavailable for streaming");
  error.status = 502;
  error.attempts = attempts;
  throw error;
}
