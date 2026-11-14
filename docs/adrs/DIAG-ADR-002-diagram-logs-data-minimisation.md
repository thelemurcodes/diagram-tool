# DIAG-ADR-002 — diagram_logs data minimisation: zero raw prompt text

**Status:** approved
**Decides:** what the `diagram_logs` table may store about a generate request, under the PROJECT.md
governance line: *"Do not log or store pasted policy content beyond what the intel view genuinely
needs."* A pasted policy can contain resident names and health details; until this decision the
`prompt` column stored up to 8,000 characters of exactly that.
**Must resolve before:** any further logging code is written.

---

## Context

`LOG_PROMPTS=true` in production made every generate request write the full raw `prompt` into the
Neon `diagram_logs` table. The prompt in `policy` mode is a pasted senior-care policy — resident
names, diagnoses, medication details — stored in cleartext.

The only reader of `diagram_logs` is `usageIntel()` (Postgres and in-memory implementations
alike), which aggregates exactly: `ts`, `mode`, `type`, `template_id`, `referer`, `success`.
It reads no prompt text. Nothing else — no admin view, no export, no debugging tooling — reads it.

## Options considered

### A — Keep the prompt, add a retention window
Delete rows older than N days. Rejected: the intel view never reads the prompt, so every day of
retention is a day of unnecessary PII exposure in a cleartext column; it converts a design flaw
into a scheduled one.

### B — Keep a truncated excerpt or keyword extraction
Store the first N characters or an extracted topic. Rejected: an excerpt of a pasted policy is
still policy content — the governance line forbids storing it, not truncating it; and no consumer
exists that would read it.

### C — Store zero raw text; log derived fields only
Log `mode`, `type`, `template_id`, `referer`, `prompt_chars`, `success`, `error`,
`mermaid_chars`, `usage_in`, `usage_out`, `ip_hash`, `ts` — everything the intel view (now or
plausibly later) needs, plus the char count to keep the existing size analytics. The raw prompt
is used for the model call and then dropped.

## Decision

**Chosen: C — store only derived fields. Zero raw prompt text.**

**Rationale:** the sole reader consumes no prompt text, so raw text has zero functional value and
non-zero privacy, security, and compliance cost. Data minimisation beats any future speculative
use: if the intel view one day genuinely needs text-derived signal, that is a new, explicit
decision with its own governance review — not a reason to keep today's copies.

**Also decided here (consequences of C):**
- **No excerpt, no keyword extraction, no retention job.** With zero raw text stored there is
  nothing to expire; a retention window would be machinery with nothing to do.
- **No `DROP COLUMN` migration.** The production `diagram_logs` table keeps its historical
  `prompt` column and its existing rows — whether to delete the already-stored prompt text is an
  owner decision (the row count holding raw policy text is reported on
  [kit-booking#21](https://github.com/thelemurcodes/kit-booking/issues/21), not guessed here).
  This codebase only stops writing it. Fresh installs (from `SCHEMA_SQL`) have no `prompt`
  column at all; production keeping a stale, nullable, never-written legacy column is accepted.
- `LogEvent` drops the `prompt` field, so the type system enforces the decision at every call
  site; the regression tests (contract suite and app-level) assert no `prompt` field reaches
  either store implementation.

**Rejected:** A (retention without minimisation — schedules the flaw instead of removing it),
B (excerpt/keywords — still policy content, still unread by anyone).

**Date:** 2026-11-13

---

## Follow-on work this decision implies

- Production owner decision (out of scope for code): whether historical `diagram_logs` rows with
  prompt text are deleted. Until decided, they remain in Neon — this is a residual, not a plan.
- The `prompt` variable itself stays in the generate handler — the model client still consumes
  it; only its persistence is removed.
- Any future feature that wants text-derived intel must come back to an ADR before re-adding a
  text column.
