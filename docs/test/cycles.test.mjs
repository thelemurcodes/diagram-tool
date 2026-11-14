/**
 * Unit tests for post-generation cycle detection (docs/cycles.mjs).
 * Run with: node --test docs/test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseFlowchartEdges, detectFlowchartCycles } from "../cycles.mjs";

const ACYCLIC = `flowchart TD
    A[Start] --> B{Issue type?}
    B -->|Dietary| C[Dietary follow-up]
    B -->|Nursing| D[Nursing follow-up]
    B -->|Housekeeping| E[Housekeeping follow-up]
    C --> F[Document and close]
    D --> F
    E --> F`;

// The run-2 failure: a linear audit path that loops back on itself.
const AUDIT_LOOP = `flowchart TD
    A[Schedule audit] --> B[Review records]
    B --> C[Walkthrough]
    C --> D[Findings report]
    D --> A
    D --> E[Close audit]`;

test("parseFlowchartEdges: simple arrows, pipe labels, and shapes", () => {
  const edges = parseFlowchartEdges(ACYCLIC);
  assert.ok(edges.some(([f, t]) => f === "A" && t === "B"));
  assert.ok(edges.some(([f, t]) => f === "B" && t === "C"));
  assert.ok(edges.some(([f, t]) => f === "B" && t === "E"));
  assert.ok(edges.some(([f, t]) => f === "C" && t === "F"));
});

test("parseFlowchartEdges: ignores non-flowchart diagram types", () => {
  assert.deepEqual(parseFlowchartEdges("sequenceDiagram\n  A->>B: hello"), []);
  assert.deepEqual(parseFlowchartEdges("mindmap\n  root\n    A"), []);
});

test("parseFlowchartEdges: skips comments and styling lines", () => {
  const code = `flowchart TD
    %% a comment
    A --> B
    classDef warn fill:#f00
    style B fill:#0f0`;
  assert.deepEqual(parseFlowchartEdges(code), [["A", "B"]]);
});

test("detectFlowchartCycles: acyclic graph finds no cycles", () => {
  assert.deepEqual(detectFlowchartCycles(ACYCLIC), []);
});

test("detectFlowchartCycles: run-2 audit-loop sample is flagged", () => {
  const cycles = detectFlowchartCycles(AUDIT_LOOP);
  assert.equal(cycles.length, 1);
  const c = cycles[0];
  assert.equal(c[0], "A");        // loop closes back at the start
  assert.equal(c[c.length - 1], "A");
  assert.ok(c.includes("D"));     // the back-edge leaves the last step
});

test("detectFlowchartCycles: diamond (not a cycle) is not flagged", () => {
  const diamond = `flowchart TD
    A --> B
    A --> C
    B --> D
    C --> D`;
  assert.deepEqual(detectFlowchartCycles(diamond), []);
});

test("detectFlowchartCycles: self-loop is flagged", () => {
  const selfLoop = `flowchart TD
    A --> A
    A --> B`;
  const cycles = detectFlowchartCycles(selfLoop);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0], ["A", "A"]);
});

test("detectFlowchartCycles: empty or absent code finds no cycles", () => {
  assert.deepEqual(detectFlowchartCycles(""), []);
  assert.deepEqual(detectFlowchartCycles(null), []);
});
