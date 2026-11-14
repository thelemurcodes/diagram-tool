/**
 * Unit tests for the policy completeness review logic (docs/review.mjs).
 * Run with: node --test docs/test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReviewPrompt,
  parseReviewResponse,
  buildExceptionPrompt,
} from "../review.mjs";

const GOOD_REVIEW = {
  normal_path: ["Verify the five rights before administration"],
  errors: ["Medication error reported to the charge nurse immediately"],
  refusals: [],
  exceptions: [
    { title: "Missed dose", detail: "Report within 15 minutes and document." },
  ],
  missing: ["Allergy check on the MAR before the dose"],
};

test("parseReviewResponse: bare JSON object", () => {
  const r = parseReviewResponse(JSON.stringify(GOOD_REVIEW));
  assert.equal(r.normal_path.length, 1);
  assert.equal(r.exceptions[0].title, "Missed dose");
  assert.deepEqual(r.refusals, []);
  assert.equal(r.missing.length, 1);
});

test("parseReviewResponse: fenced ```json block", () => {
  const raw = "```json\n" + JSON.stringify(GOOD_REVIEW) + "\n```";
  const r = parseReviewResponse(raw);
  assert.equal(r.errors.length, 1);
  assert.equal(r.exceptions[0].detail, "Report within 15 minutes and document.");
});

test("parseReviewResponse: JSON embedded in prose", () => {
  const raw =
    'Here is the review:\n{"normal_path":["Step one"],"missing":["Section 4 escalation"]} hope that helps';
  const r = parseReviewResponse(raw);
  assert.deepEqual(r.normal_path, ["Step one"]);
  assert.deepEqual(r.missing, ["Section 4 escalation"]);
  assert.deepEqual(r.exceptions, []);
});

test("parseReviewResponse: mermaid response (recorded-fake shape) is rejected", () => {
  const mermaid =
    "flowchart TD\n  A[Policy: incident reported] --> B[Ensure resident safety]";
  assert.equal(parseReviewResponse(mermaid), null);
});

test("parseReviewResponse: garbage, empty, and non-object inputs are rejected", () => {
  assert.equal(parseReviewResponse(""), null);
  assert.equal(parseReviewResponse("not json at all"), null);
  assert.equal(parseReviewResponse("[1,2,3]"), null);
  assert.equal(parseReviewResponse('"a string"'), null);
  assert.equal(parseReviewResponse(null), null);
  assert.equal(parseReviewResponse('{"unknown_key":[1]}'), null);
});

test("parseReviewResponse: drops non-string list entries and bad exception shapes", () => {
  const raw = JSON.stringify({
    normal_path: ["ok", 42, null, "  ", "also ok"],
    errors: "not an array",
    exceptions: [
      { title: "Good", detail: "Fine" },
      "junk",
      null,
      { nope: true },
      { title: "  ", detail: "detail only" },
    ],
    missing: [{}],
  });
  const r = parseReviewResponse(raw);
  assert.deepEqual(r.normal_path, ["ok", "also ok"]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.exceptions.length, 2);
  assert.equal(r.exceptions[0].title, "Good");
  assert.equal(r.exceptions[1].title, "");
  assert.equal(r.exceptions[1].detail, "detail only");
  assert.deepEqual(r.missing, []);
});

test("parseReviewResponse: all-empty categories stay valid (fully covered policy)", () => {
  const r = parseReviewResponse(
    JSON.stringify({ normal_path: [], errors: [], refusals: [], exceptions: [], missing: [] })
  );
  assert.notEqual(r, null);
  assert.deepEqual(r.missing, []);
});

test("buildReviewPrompt: includes the policy verbatim and the diagram", () => {
  const p = buildReviewPrompt("SECTION 1. Do the thing.", "flowchart TD\n A-->B", 20000);
  assert.match(p, /SECTION 1\. Do the thing\./);
  assert.match(p, /flowchart TD\n A-->B/);
  assert.match(p, /ONLY a JSON object/);
  assert.match(p, /completeness review/);
});

test("buildReviewPrompt: drops the diagram before the policy when tight", () => {
  const policy = "P".repeat(7000);
  const diagram = "D".repeat(2000);
  // Fits policy + instructions but not the diagram.
  const cap = 8000;
  const p = buildReviewPrompt(policy, diagram, cap);
  assert.notEqual(p, null);
  assert.ok(p.includes(policy), "policy must survive verbatim");
  assert.ok(!p.includes(diagram), "diagram is dropped first");
});

test("buildReviewPrompt: null when even the policy cannot fit under the cap", () => {
  assert.equal(buildReviewPrompt("P".repeat(9000), "", 8000), null);
});

test("buildExceptionPrompt: uses title + detail, stays short", () => {
  const p = buildExceptionPrompt({
    title: "Missed dose",
    detail: "Report to the charge nurse within 15 minutes and document.",
  });
  assert.match(p, /Missed dose/);
  assert.match(p, /charge nurse within 15 minutes/);
  assert.ok(p.length < 1000);
});

test("buildExceptionPrompt: truncates very long details to a bounded prompt", () => {
  const p = buildExceptionPrompt({ title: "T", detail: "x".repeat(5000) });
  assert.ok(p.length < 1000, `prompt too long: ${p.length}`);
  assert.match(p, /\.\.\./);
});

test("buildExceptionPrompt: handles missing fields", () => {
  assert.equal(
    buildExceptionPrompt({ title: "", detail: "" }),
    "Diagram ONLY this exception procedure from a senior-care policy, as a standalone flowchart. " +
      "Exception: . Include who acts, the decision points, and where the path escalates or rejoins the normal flow."
  );
  assert.doesNotThrow(() => buildExceptionPrompt(null));
});
