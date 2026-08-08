// Shared upstream HTTP concerns: error shape and timeouts.
//
// There was previously no timeout anywhere in the adapters. `fetch` has no
// default one, so a provider that accepted the connection and then stopped
// responding held the client request open indefinitely — and because the
// call never rejected, the fallback chain never advanced to the next
// candidate. A hung provider took the request down instead of being routed
// around, which is precisely what the resilience layer exists to prevent.

export const REQUEST_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 120_000;

// Streaming can legitimately run far longer than a buffered call, so the
// total-duration bound is replaced by a bound on the gap between chunks.
export const STREAM_STALL_TIMEOUT_MS = Number(process.env.UPSTREAM_STALL_TIMEOUT_MS) || 90_000;

export class ProviderError extends Error {
  constructor(providerId, status, body, opts = {}) {
    super(`Provider ${providerId} failed with HTTP ${status}: ${String(body ?? "").slice(0, 300)}`);
    this.name = "ProviderError";
    this.providerId = providerId;
    this.status = status;
    this.retryable =
      opts.retryable !== undefined ? opts.retryable : status === 408 || status === 429 || status >= 500;
    // Kept separate from `message` so the client-facing error can omit the
    // upstream body while operators still get it in the logs.
    this.upstreamBody = String(body ?? "").slice(0, 300);
  }
}

// A timeout is deliberately NOT retryable. Retrying the same unresponsive
// provider twice with backoff would triple the wait before the fallback
// chain gets a turn; moving on immediately is the whole point of having one.
export class UpstreamTimeoutError extends ProviderError {
  constructor(providerId, ms, phase) {
    super(providerId, 504, `no response for ${ms}ms (${phase})`, { retryable: false });
    this.name = "UpstreamTimeoutError";
    this.timeoutMs = ms;
    this.phase = phase;
  }
}

// Issues the request under an abort deadline. The caller gets back the
// response plus a `done()` to stop the clock — for buffered calls that
// happens after the body is fully read, so a provider can't stall midway
// through the body either.
export async function fetchUpstream(providerId, url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return { res, done: () => clearTimeout(timer), controller, timedOut: () => timedOut };
  } catch (err) {
    clearTimeout(timer);
    if (timedOut) throw new UpstreamTimeoutError(providerId, timeoutMs, "connect");
    // Connection refused / DNS failure / TLS error: real, immediate, and
    // not worth retrying the same endpoint over.
    throw err;
  }
}

// Buffered request: send, check status, read the whole body, stop the clock.
export async function requestJson(providerId, url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const { res, done, timedOut } = await fetchUpstream(providerId, url, options, timeoutMs);
  try {
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new ProviderError(providerId, res.status, errText);
    }
    return await res.json();
  } catch (err) {
    if (timedOut()) throw new UpstreamTimeoutError(providerId, timeoutMs, "body");
    throw err;
  } finally {
    done();
  }
}

// Opens a stream and validates status before returning, so a bad key or a
// 5xx still lets the router fall back with nothing written to the client.
export async function openStream(providerId, url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const { res, done, controller, timedOut } = await fetchUpstream(providerId, url, options, timeoutMs);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    done();
    if (timedOut()) throw new UpstreamTimeoutError(providerId, timeoutMs, "connect");
    throw new ProviderError(providerId, res.status, errText);
  }

  done(); // headers are in; the stall watchdog takes over from here
  return { body: res.body, controller };
}

// Wraps a reader so a stream that goes silent fails instead of hanging
// forever. Each successful read resets the clock.
export async function* readWithStallTimeout(
  body,
  providerId,
  controller,
  stallMs = STREAM_STALL_TIMEOUT_MS
) {
  const reader = body.getReader();
  try {
    while (true) {
      let stallTimer;
      const stalled = new Promise((_, reject) => {
        stallTimer = setTimeout(() => {
          controller?.abort();
          reject(new UpstreamTimeoutError(providerId, stallMs, "stream"));
        }, stallMs);
      });

      let result;
      try {
        result = await Promise.race([reader.read(), stalled]);
      } finally {
        clearTimeout(stallTimer);
      }

      if (result.done) return;
      yield result.value;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}
