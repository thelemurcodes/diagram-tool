/**
 * Unit tests for the underspecified-input guard (docs/inputGuard.mjs).
 * Run with: node --test docs/test/
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isUnderspecified } from "../inputGuard.mjs";

test("isUnderspecified: one-character input 'x' is rejected", () => {
  assert.equal(isUnderspecified("x"), true);
});

test("isUnderspecified: empty and whitespace-only input is rejected", () => {
  assert.equal(isUnderspecified(""), true);
  assert.equal(isUnderspecified("   "), true);
});

test("isUnderspecified: single short word is rejected", () => {
  assert.equal(isUnderspecified("audit"), true);
});

test("isUnderspecified: punctuation-only padding does not make input substantive", () => {
  assert.equal(isUnderspecified("x . ! -"), true);
});

test("isUnderspecified: a short but meaningful description passes", () => {
  assert.equal(isUnderspecified("intake flow"), false);
  assert.equal(isUnderspecified("Show handoff"), false);
});

test("isUnderspecified: a pasted policy passes", () => {
  const policy = "Policy: All medication errors must be reported to the charge nurse within 15 minutes.";
  assert.equal(isUnderspecified(policy), false);
});
