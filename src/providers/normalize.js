// Every adapter must return this shape so the router/cost-tracker/caller
// never need to know which upstream actually answered.
export function normalizedResponse({
  id,
  providerId,
  model,
  content,
  toolCalls,
  finishReason,
  usage,
  promptText,
  raw
}) {
  const message = { role: "assistant", content };
  if (toolCalls) {
    message.tool_calls = toolCalls;
    message.content = content || null; // OpenAI convention: null content when the turn is a tool call
  }

  // When a provider reports usage, use it. When it doesn't, estimate from
  // the text actually sent and received.
  //
  // The previous fallback read `raw?.promptEcho`, a field no adapter has
  // ever set, so `JSON.stringify(undefined || "")` estimated every
  // unreported prompt at a single token regardless of size. A 50k-token
  // request recorded as 1 token of input cost, which flowed straight into
  // the monthly budget caps.
  const reportedPrompt = Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : null;
  const reportedCompletion = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : null;

  const promptTokens = reportedPrompt ?? estimateTokens(promptText);
  const completionTokens = reportedCompletion ?? estimateTokens(content);

  return {
    id: id || `tollpike-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    provider: providerId,
    // Marks spend figures derived from a local heuristic rather than the
    // provider's own accounting, so the panel can say which is which
    // instead of presenting both as measured.
    usage_source: reportedPrompt === null || reportedCompletion === null ? "estimated" : "provider",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason || "stop"
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  };
}

// Serializes whatever the caller sent upstream into estimable text.
export function promptTextOf(request) {
  try {
    return JSON.stringify(request?.messages ?? "");
  } catch {
    return "";
  }
}

// Cheap fallback estimator when a provider doesn't report usage.
// ~4 chars/token is the standard rough heuristic for English text.
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}
