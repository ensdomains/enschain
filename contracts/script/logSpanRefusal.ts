/// Recognising a provider's refusal of a log query's *span*, as opposed to a failure
/// of the query itself.
///
/// A span refusal means "ask for less" and is answered by bisecting the range; every
/// other error is a real failure and must propagate, because a scan that quietly
/// narrows past an unrelated fault returns a partial view of the chain and the audits
/// built on it are explicit that a partial result must never pass for a complete one.
///
/// The distinction is drawn on an allowlist of phrasings rather than on keywords.
/// Matching a bare `limit` or `too many` sweeps in `rate limit exceeded`, and a
/// throttled endpoint is then bisected toward single blocks — hundreds of doomed
/// requests — instead of surfacing the throttle.

/// Phrasings that mean the block range or the result count exceeded a server-side cap.
/// Each is a substring match against the lower-cased message chain.
const LOG_SPAN_REFUSALS = [
  "block range",
  // Some providers pluralise it: "eth_getLogs is limited to a 1000 blocks range".
  "blocks range",
  "range exceeds",
  // Some put the offending count between the words, e.g. Infura's
  // "range 11390003 exceeds limit of 10000", which "range exceeds" misses.
  "exceeds limit",
  "exceed maximum block range",
  "narrow your filter",
  "query returned more than",
  "more than 10000 results",
  "log response size",
  "response size exceeded",
  "query timeout exceeded",
  "query exceeds max results",
];

/// Whether a message describes a refusal of the span rather than of the query.
export function isLogSpanRefusalMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return LOG_SPAN_REFUSALS.some((refusal) => normalized.includes(refusal));
}
