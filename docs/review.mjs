/**
 * Policy completeness review — pure logic for the post-generation checklist
 * (policy mode only). Kept in its own ESM module so the buildless frontend
 * (docs/index.html) and the unit tests (docs/test/) share one implementation.
 *
 * Privacy: these functions never log or persist anything. The only network
 * destination for policy text is the same generation endpoint the user's
 * original paste already went to.
 */

/**
 * Build the "review the pasted policy against the generated diagram" prompt.
 * Reuses the existing generation endpoint/message path: the policy + diagram
 * go to the same POST / the original generation used, framed as a user message
 * that demands JSON-only output.
 *
 * @param {string} policyText  The user's pasted policy (verbatim).
 * @param {string} mermaidCode The generated diagram code.
 * @param {number} maxChars    The request cap the endpoint enforces (413 above it).
 * @returns {string|null} The prompt, or null when the review cannot fit under
 *   the cap (caller skips the review — the diagram itself is unaffected).
 */
export function buildReviewPrompt(policyText, mermaidCode, maxChars) {
  const policy = String(policyText || "");
  const diagram = String(mermaidCode || "");

  const instructions = [
    "You are doing a completeness review of a diagram that was generated from a policy.",
    "Compare the policy text against the generated diagram and report what the diagram may have left out.",
    "",
    "Policy:",
    '"""',
    policy,
    '"""',
  ].join("\n");

  // The diagram is context, not the subject. If it does not fit, review the
  // policy alone rather than truncating either the policy or the diagram.
  const diagramBlock = [
    "",
    "Generated diagram (Mermaid):",
    diagram,
  ].join("\n");

  const jsonShape =
    'Respond with ONLY a JSON object, no prose and no code fences, exactly in this shape:\n' +
    '{"normal_path":["step from the policy"],"errors":["error the policy handles"],"refusals":["refusal the policy handles"],"exceptions":[{"title":"short name","detail":"one-sentence summary"}],"missing":["requirement that appears in the policy text but not in the diagram"]}\n' +
    "Rules: every list item must come from the policy text itself, closely paraphrased. " +
    "If a category has nothing in this policy, use an empty list. " +
    "Keep each item under 20 words. This is a completeness review — output ONLY the JSON object.";

  const withDiagram = instructions + diagramBlock + "\n\n" + jsonShape;
  if (withDiagram.length <= maxChars) return withDiagram;

  const withoutDiagram = instructions + "\n\n" + jsonShape;
  if (withoutDiagram.length <= maxChars) return withoutDiagram;

  return null;
}

/**
 * Parse the model's review response into a checklist shape.
 * Deliberately forgiving: the shared endpoint's system prompt asks for Mermaid
 * output, so the review model may wrap the JSON in fences or stray prose.
 *
 * @param {string} raw
 * @returns {{normal_path: string[], errors: string[], refusals: string[],
 *   exceptions: {title: string, detail: string}[], missing: string[]} | null}
 *   null when no JSON object can be recovered (caller hides the checklist).
 */
export function parseReviewResponse(raw) {
  const text = stripFences(String(raw || ""));
  const obj = tryParseObject(text);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const strings = (v) =>
    Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim()) : [];

  const exceptions = Array.isArray(obj.exceptions)
    ? obj.exceptions
        .filter((e) => e && typeof e === "object")
        .map((e) => ({
          title: typeof e.title === "string" ? e.title.trim() : "",
          detail: typeof e.detail === "string" ? e.detail.trim() : "",
        }))
        .filter((e) => e.title || e.detail)
    : [];

  const hasAnyKnownKey = [
    "normal_path",
    "errors",
    "refusals",
    "exceptions",
    "missing",
  ].some((k) => k in obj);
  if (!hasAnyKnownKey) return null;

  return {
    normal_path: strings(obj.normal_path),
    errors: strings(obj.errors),
    refusals: strings(obj.refusals),
    exceptions,
    missing: strings(obj.missing),
  };
}

/**
 * Build the per-exception regeneration prompt for a "Diagram this" button.
 * Sent through the same generation endpoint in policy mode; only the model's
 * short exception summary travels — no new exposure of the raw policy.
 *
 * @param {{title: string, detail: string}} exception
 * @returns {string}
 */
export function buildExceptionPrompt(exception) {
  const title = String((exception && exception.title) || "").trim();
  const detail = String((exception && exception.detail) || "").trim();
  const subject = [title, detail].filter(Boolean).join(" — ");
  // Keep the re-issued prompt comfortably inside the smallest endpoint cap.
  const trimmed = subject.length > 600 ? subject.slice(0, 597) + "..." : subject;
  return (
    "Diagram ONLY this exception procedure from a senior-care policy, as a standalone flowchart. " +
    "Exception: " + trimmed + ". " +
    "Include who acts, the decision points, and where the path escalates or rejoins the normal flow."
  );
}

/** Strip ```json fences (and bare backticks) the server's cleaner may leave. */
function stripFences(s) {
  let out = s.trim();
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) out = fence[1].trim();
  return out.replace(/^`+|`+$/g, "").trim();
}

/** JSON.parse, with a fallback that extracts the outermost {...} block. */
function tryParseObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to brace extraction */
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
