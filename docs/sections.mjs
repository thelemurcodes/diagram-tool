/**
 * Deterministic policy-section completeness guard (policy mode only).
 * Pure logic, no model call: parses section headings out of the pasted
 * policy text and checks each against the generated diagram text
 * (Mermaid node/edge labels). Complements the model-driven checklist in
 * review.mjs — it catches silent section drops the model review misses.
 *
 * Kept in its own ESM module so the buildless frontend (docs/index.html)
 * and the unit tests (docs/test/) share one implementation.
 */

/** Words too generic to identify a section if they appear alone. */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "this", "that", "with", "a", "an", "of", "or",
  "to", "in", "on", "by", "at", "is", "be",
  // structural labels: every policy has these, so they can never be
  // distinctive evidence that a section made it into the diagram
  "section", "subsection", "appendix", "part", "article",
]);

/** Lines longer than this are almost certainly sentences, not headings. */
const MAX_HEADING_LENGTH = 80;

/**
 * Parse section headings from pasted policy text.
 * Conservative by design — a false heading produces a false "missing"
 * warning, which is worse than missing a marginal heading. Supported:
 *   - markdown headings: "# Purpose", "## Special Circumstances"
 *   - numbered section lines: "1. Purpose", "4.2 Intake",
 *     "Section 4 - Special Circumstances"
 *   - standalone ALL-CAPS lines: "SPECIAL CIRCUMSTANCES"
 *   - standalone Title Case lines: "Special Circumstances"
 *
 * @param {string} policyText
 * @returns {string[]} Heading texts (original casing, deduplicated), in
 *   document order.
 */
export function parsePolicyHeadings(policyText) {
  const seen = new Set();
  const headings = [];
  for (const rawLine of String(policyText || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = matchHeading(line);
    if (heading === null || seen.has(heading)) continue;
    seen.add(heading);
    headings.push(heading);
  }
  return headings;
}

/**
 * Headings from the policy that have no counterpart in the diagram text.
 * A heading counts as covered when at least half of its distinctive words
 * (minimum one) appear in the diagram text — tolerates case differences
 * and light rewording (singular/plural handled).
 *
 * @param {string} policyText  The user's pasted policy (verbatim).
 * @param {string} diagramText The generated diagram text (Mermaid source).
 * @returns {string[]} Unmatched heading texts, in document order.
 */
export function findUncoveredHeadings(policyText, diagramText) {
  const diagram = String(diagramText || "").toLowerCase();
  return parsePolicyHeadings(policyText).filter(
    (heading) => !isCovered(headingTokens(heading), diagram),
  );
}

/** Return the heading text if the line looks like one, else null. */
function matchHeading(line) {
  if (!line || line.length > MAX_HEADING_LENGTH) return null;

  // markdown heading: "# Title" .. "###### Title"
  const md = line.match(/^#{1,6}\s+(\S.*)$/);
  if (md) return cleanHeadingText(md[1].replace(/\s*#+\s*$/, ""));

  // list items, table rows, block quotes, code — never headings
  if (/^([-*+•>]|```|\|)/.test(line)) return null;

  // numbered section line: "1. Purpose", "4.2 Intake",
  // "Section 4 - Special Circumstances", "Section 4: Special Circumstances"
  const numbered = line.match(
    /^(?:section\s+\d+\s*[-–—:.)]*\s*|\d+(?:\.\d+)+\s+|\d+\s*[-–—:.)]\s+)(\S.*)$/i,
  );
  if (numbered) return cleanHeadingText(numbered[1]);

  // standalone ALL-CAPS line ("SPECIAL CIRCUMSTANCES", "PURPOSE").
  // Requires a trailing-letters check so "N/A" style lines don't match.
  if (/^[A-Z][A-Z0-9 ,'&()\-–—/]+$/.test(line) && /[A-Z]{3,}/.test(line)) {
    return cleanHeadingText(line);
  }

  // standalone Title Case line ("Special Circumstances") — at least two
  // words, every word capitalised or a known minor word, no sentence punctuation
  if (
    line.length >= 3 &&
    !/[.!?;:]$/.test(line) &&
    /^([A-Z][A-Za-z'-]*)(\s+(?:of|the|and|to|for|in|on|with|[A-Z][A-Za-z'-]*))+$/.test(line)
  ) {
    return cleanHeadingText(line);
  }

  return null;
}

/** Reject heading text that is really a sentence or a stray fragment. */
function cleanHeadingText(text) {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t || t.length > MAX_HEADING_LENGTH) return null;
  // a heading body must start with a letter (not a number or symbol)
  if (!/^[A-Za-z]/.test(t)) return null;
  // sentences end in a period or contain mid-line sentence punctuation
  if (/[.!?;:]$/.test(t) || /\s[.!?;:]\s/.test(t)) return null;
  return t;
}

/**
 * Distinctive words of a heading: lowercase, punctuation-stripped,
 * stopwords and tiny tokens removed.
 * @param {string} heading
 * @returns {string[]}
 */
function headingTokens(heading) {
  return String(heading || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * True when enough of the heading's distinctive tokens appear in the
 * lowercased diagram text. Token match is word-boundary based and
 * tolerates singular/plural ("circumstances" ↔ "circumstance").
 * @param {string[]} tokens
 * @param {string} lowerDiagram
 * @returns {boolean}
 */
function isCovered(tokens, lowerDiagram) {
  if (!tokens.length) return true; // nothing distinctive to demand
  const matched = tokens.filter((t) => tokenRegex(t).test(lowerDiagram)).length;
  return matched * 2 >= tokens.length; // >= half, minimum one via ceil
}

/**
 * Word-boundary regex for a token, tolerating a dropped/added plural "s"
 * or "es" (only for stems that are not already plural-looking, e.g. "ss").
 * @param {string} token
 * @returns {RegExp}
 */
function tokenRegex(token) {
  let stem = token;
  if (token.length > 4 && /[^s]s$/.test(token)) stem = token.replace(/es?$|s$/, "");
  return new RegExp("\\b" + escapeRegExp(stem) + "(?:es|s)?\\b");
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
