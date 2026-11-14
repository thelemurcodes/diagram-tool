/**
 * Underspecified-input guard — pure logic for the generation flow. Kept in its
 * own ESM module so the buildless frontend (docs/index.html) and the unit
 * tests (docs/test/) share one implementation.
 *
 * The backend enforces the same floors server-side (server/src/config.ts
 * LIMITS.MIN_PROMPT_* + server/src/util.ts isUnderspecified) — keep both in
 * sync. Input below these floors makes the model silently invent a workflow
 * (eval-harness run 2, finding B) instead of the user being asked for detail.
 */

const MIN_WORDS = 2;        // fewer words than this is not a describable process
const MIN_ALNUM_CHARS = 5;  // substantive characters, ignoring punctuation/spacing

/**
 * @param {string} text The user's prompt (already trimmed by the caller).
 * @returns {boolean} True when the input is too thin to diagram from.
 */
export function isUnderspecified(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORDS) return true;
  const alnum = String(text || "").replace(/[^a-zA-Z0-9]/g, "");
  return alnum.length < MIN_ALNUM_CHARS;
}
