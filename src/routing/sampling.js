// The sampling parameters this gateway carries from a caller to a provider.
//
// These were being accepted and silently dropped. `prepare()` built its
// payload from an explicit allowlist, every adapter built its request body
// from another one, and neither included these, so a caller asking for
// `response_format: { type: "json_object" }` or `stop: ["\n\n"]` got a 200
// back with prose that ignored both. That is the failure this project already
// names in its own docs: a capability a vendor doesn't have should be reported
// as unsupported rather than emulated, and returning success without doing the
// thing is worse than not offering it.
//
// One list, used by the payload builder, the cache key and the adapters. Three
// allowlists that have to agree is how the original drift happened, so adding a
// parameter here has to be enough to carry it end to end.
//
// `n` is deliberately absent. normalizedResponse only ever reads choices[0],
// so forwarding it would return one completion out of the n the caller paid
// for and undercount the spend. It is rejected at the edge instead.
export const SAMPLING_PARAMS = [
  "top_p",
  "stop",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "logit_bias",
  "response_format"
];

// Only the keys the caller actually sent. Copying undefined across would put
// `"top_p": undefined` into a provider body, and more importantly would change
// the cache key for a request that did not ask for anything.
export function pickSampling(source = {}) {
  const out = {};
  for (const key of SAMPLING_PARAMS) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return out;
}

// Does this request ask for JSON back? Both adapters that can honour it need
// the same answer, and the two response_format shapes (json_object and
// json_schema) both mean "JSON".
export function wantsJson(request) {
  const type = request?.response_format?.type;
  return type === "json_object" || type === "json_schema";
}
