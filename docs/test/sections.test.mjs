/**
 * Unit tests for the deterministic section-completeness guard
 * (docs/sections.mjs). Run with: node --test docs/test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  parsePolicyHeadings,
  findUncoveredHeadings,
} from "../sections.mjs";

const SAMPLE_POLICY = [
  "1. Purpose",
  "This policy defines how staff support residents every day.",
  "",
  "Section 4 - Special Circumstances",
  "When a resident refuses care, follow the escalation protocol.",
].join("\n");

test("parsePolicyHeadings: markdown headings", () => {
  const md = "# Purpose\n\nbody text\n\n## Special Circumstances\n\nmore text";
  assert.deepEqual(parsePolicyHeadings(md), ["Purpose", "Special Circumstances"]);
});

test("parsePolicyHeadings: numbered section lines", () => {
  const p = "1. Purpose\nbody\n\n4.2 Intake\nbody\n\nSection 4 - Special Circumstances\nbody";
  assert.deepEqual(
    parsePolicyHeadings(p),
    ["Purpose", "Intake", "Special Circumstances"],
  );
});

test("parsePolicyHeadings: standalone ALL-CAPS lines", () => {
  const p = "Some intro line.\nSPECIAL CIRCUMSTANCES\nbody of the section";
  assert.deepEqual(parsePolicyHeadings(p), ["SPECIAL CIRCUMSTANCES"]);
});

test("parsePolicyHeadings: standalone Title Case lines", () => {
  const p = "intro sentence here\nResident Admission Process\nbody follows";
  assert.deepEqual(parsePolicyHeadings(p), ["Resident Admission Process"]);
});

test("parsePolicyHeadings: conservative — skips sentences, lowercase lines, list items", () => {
  const p = [
    "this whole line is lowercase so it is not a heading",
    "This line ends with a period, like a sentence.",
    "- a bullet list item",
    "* another bullet",
    "> a blockquote",
    "This is a much longer line that reads like a body paragraph because it goes on and on and on and would never be a heading",
  ].join("\n");
  assert.deepEqual(parsePolicyHeadings(p), []);
});

test("parsePolicyHeadings: deduplicates repeated headings, keeps order", () => {
  const p = "1. Purpose\nbody\n1. Purpose\nbody\n## Special Circumstances";
  assert.deepEqual(
    parsePolicyHeadings(p),
    ["Purpose", "Special Circumstances"],
  );
});

test("parsePolicyHeadings: empty and null inputs", () => {
  assert.deepEqual(parsePolicyHeadings(""), []);
  assert.deepEqual(parsePolicyHeadings(null), []);
});

test("findUncoveredHeadings: warns when a section is missing from the diagram", () => {
  // The reproduced persona-run-2 failure: an entire 'Special Circumstances'
  // section silently dropped from the generated diagram.
  const diagram = [
    "flowchart TD",
    '  A["Policy purpose: care begins"] --> B["Verify resident identity"]',
    '  B --> C["Provide daily care"]',
  ].join("\n");
  const gaps = findUncoveredHeadings(SAMPLE_POLICY, diagram);
  assert.deepEqual(gaps, ["Special Circumstances"]);
});

test("findUncoveredHeadings: fully covered policy produces no warning", () => {
  const diagram = [
    "flowchart TD",
    '  A["Purpose: define resident care"] --> B["Special circumstances: resident refuses care"]',
    "  B --> C[\"Escalate per protocol\"]",
  ].join("\n");
  assert.deepEqual(findUncoveredHeadings(SAMPLE_POLICY, diagram), []);
});

test("findUncoveredHeadings: match tolerates case and singular/plural", () => {
  const diagram = 'flowchart TD\n  A["Special circumstance handling"] --> B[Next]';
  // "Purpose" from "1. Purpose" is still absent, "Special Circumstances" covered
  assert.deepEqual(findUncoveredHeadings(SAMPLE_POLICY, diagram), ["Purpose"]);
});

test("findUncoveredHeadings: structural words alone never count as coverage", () => {
  const diagram = "flowchart TD\n  A[Section 4 - see appendix for policy text]";
  const gaps = findUncoveredHeadings(SAMPLE_POLICY, diagram);
  assert.ok(gaps.includes("Special Circumstances"));
});

test("findUncoveredHeadings: heading covered when half its distinctive words match", () => {
  const policy = "Special Circumstances";
  // only "special" present — one of two distinctive words → covered
  const diagram = 'flowchart TD\n  A["Special handling procedure"] --> B';
  assert.deepEqual(findUncoveredHeadings(policy, diagram), []);
});

test("findUncoveredHeadings: empty diagram flags every heading", () => {
  assert.deepEqual(
    findUncoveredHeadings(SAMPLE_POLICY, ""),
    ["Purpose", "Special Circumstances"],
  );
});

test("findUncoveredHeadings: null/undefined inputs are safe", () => {
  assert.deepEqual(findUncoveredHeadings(null, "flowchart TD"), []);
  assert.doesNotThrow(() => findUncoveredHeadings(SAMPLE_POLICY, undefined));
});
