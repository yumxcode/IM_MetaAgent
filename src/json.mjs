/**
 * Preserve protocol uint64 identifiers before JSON.parse can round them.
 * Only integer values of actual JSON properties are rewritten; quoted text and
 * ordinary numeric fields retain the normal JSON.parse representation.
 */
const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

export function parseJsonLossless(rawText) {
  if (typeof rawText !== "string") throw new TypeError("JSON response must be a string");
  const chunks = [];
  let index = 0;
  let unchangedStart = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') { index++; continue; }
    const start = index++;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') break;
    }
    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? "")) cursor++;
    if (rawText[cursor] !== ":") continue;
    let key;
    try { key = JSON.parse(rawText.slice(start, index)); } catch { continue; }
    if (!LOSSLESS_ID_FIELDS.has(key)) continue;
    cursor++;
    while (/\s/.test(rawText[cursor] ?? "")) cursor++;
    // Require a complete integer token, not a prefix of a fraction/exponent.
    const number = /^-?(?:0|[1-9]\d*)(?=[\s,}\]]|$)/.exec(rawText.slice(cursor));
    if (!number) continue;
    chunks.push(rawText.slice(unchangedStart, cursor), '"', number[0], '"');
    index = cursor + number[0].length;
    unchangedStart = index;
  }
  chunks.push(rawText.slice(unchangedStart));
  return JSON.parse(chunks.join(""));
}

/** Upstream naming retained for callers ported from the official plugin. */
export const parseWeixinApiJson = parseJsonLossless;
