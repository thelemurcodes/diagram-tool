# DIAG-ADR-001 — Lead-capture design

**Status:** approved
**Decides:** the mechanism for PROJECT.md priority #2 ("optional lead capture") — how anonymous SEO
traffic converts into a reachable, consent-clear lead list without violating the free-tier, no-login,
minimal-collection, or PII-sensitivity constraints in PROJECT.md.
**Must resolve before:** any lead-capture code is written.

---

## Context

PROJECT.md names "optional lead capture" as the funnel's #2 priority: a frictionless, optional,
post-value email capture ("email me the PDF / notify me of new templates") that turns anonymous SEO
traffic into a lead list for the consultant — without gating the free tool or violating the
project's governance line: *"treat captured identity as sensitive: minimal collection, clear terms
(`docs/terms.html` needs legal review before launch), no selling/sharing."*

The project's own constraints also apply: free-tier economics (no new paid dependency without an
explicit decision), the API key must never be exposed, and the frontend stays buildless.

## Options considered

### A — Custom Firestore-backed "email me the PDF" capture
Generate + auto-email a PDF of the diagram. Rejected before formal review: requires a new paid
email-sending dependency, a new client-side PDF-rendering dependency, and lets anyone auto-send
arbitrary content to a third-party address they don't control — the largest abuse surface and PII
footprint for an unproven first iteration.

### B — Custom Firestore-backed "notify me" capture (original recommendation)
A frictionless, optional, post-value opt-in ("want a heads-up on new templates?") writing directly
to a new, separate Firestore `leads` collection. No PDF, no automated outbound email.

**Adversarial review (skeptic-cert) result: BREAK.** Real holes, not nitpicks:
1. **Critical** — the new endpoint doesn't actually inherit the existing rate-limit/cost-guard
   system (`allow()`/`LIMITS` in `server/index.js`). CORS is browser-enforced, not server auth; a
   script can flood Firestore writes past the free-tier quota with no cap named anywhere.
2. **Critical** — "no PDF" doesn't stop abuse: nothing verifies the submitted email belongs to the
   submitter. Anyone can plant a stranger's address, and it lands in a list the consultant later
   manually contacts from — our infra becomes an unwitting spam vector.
3. **High** — inline consent text next to a field is not real opt-in; no checkbox tied to a
   terms-version timestamp, which undercuts the "clear terms" governance requirement.
4. **High** — "hold live pending legal review" was a verbal promise, not a mechanism. This is a
   static site + a manually-redeployed Cloud Function with no staging/flag — the moment code merges
   and `deploy.sh` runs, it's live, terms-reviewed or not.
5. **Medium** — no deletion-propagation story once the consultant manually exports the collection
   elsewhere (Firestore-side deletion doesn't reach a copied spreadsheet/CRM).

### C — Third-party form embed (Tally/Google Forms free tier)
Zero new backend code; consent, unsubscribe, and abuse handling live with a provider built for it;
turning it on/off is just adding/removing a link (no deploy-state ambiguity). Considered and
presented as the default alongside Option B-hardened.

### D — Custom Firestore-backed build, hardened per the skeptic's findings
Same shape as B, plus:
- A literal `LEAD_CAPTURE_ENABLED` kill switch (default **off**) gating both the backend action
  branch and the frontend widget render — "built" and "live" become genuinely different states.
- The new endpoint reuses the existing `allow()`/`hits` rate limiter under a new keyspace
  (`lead:${ipHash}`, e.g. 3/day) plus a hard Firestore-write daily cap mirroring `GLOBAL_PER_DAY`.
- Double opt-in: a confirmation email before a submission is treated as a confirmed lead (requires
  picking a minimal transactional-email sender — a small, separate, explicit dependency decision,
  much smaller in footprint than PDF-sending infra).
- An explicit **unchecked** opt-in checkbox tied to a terms-version timestamp, not just inline text.
- A `docs/terms.html` clause drafted for legal review, with the kill switch left off until that
  review is confirmed.

## Decision

**Chosen: D — first-party hardened custom build**, overriding the Tally/Option-C default that was
presented alongside it.

**Rationale (owner's call):** keep the feature first-party — full design/brand control, no new
third-party data processor to vet against the "no selling/sharing" governance line, and the
skeptic's four hardening requirements (kill switch, rate-limit reuse, double opt-in, explicit
checkbox) close the real gaps directly rather than by outsourcing them. The tradeoff accepted:
more owned code/surface to maintain, and a new (small) transactional-email-sender dependency for
the double-opt-in confirmation, which is being made here as the explicit decision PROJECT.md's
free-tier clause requires.

**Rejected:** A (PDF variant — abuse/dependency footprint too large for a first iteration), B
unhardened (skeptic BREAK), C (third-party embed — available as a fallback if D proves too costly
to build/maintain, not chosen now).

**Date:** 2026-07-05

---

## Follow-on work this decision implies

- `LEAD_CAPTURE_ENABLED` env var (default `false`) gates the new backend endpoint (both the
  `lead_capture` POST action and the `lead_confirm` GET action).
- `LEAD_CAPTURE_UI_ENABLED` (a plain `const` in `docs/index.html`, default `false`) gates the
  frontend widget's render — **correction, 2026-07-05:** the backend env var cannot be read by a
  static site, so it was never true that one flag gated both halves as originally written above;
  this is a second, independent flag that must be flipped alongside the backend one when going
  live, not a consequence of it. Caught by an independent post-merge security QC (see below), not
  by the original design review.
- New `lead:${ipHash}` rate-limit keyspace + a hard daily Firestore-write cap on the `leads` write
  path — **and, since the same QC pass, an equivalent limiter on the `lead_confirm` GET path**
  (the original hardening only covered the write side; the confirm-token lookup is also an
  unauthenticated, unbounded Firestore read once the feature is live).
- **Operational guardrail for manual lead review (A-2 residual, not a code enforcement point):**
  the `leads` collection contains both `pending` and `confirmed` rows. Only ever contact/export
  rows where `status === 'confirmed'` — a `pending` row means the email was submitted but never
  verified by its owner clicking the confirmation link, and could belong to anyone (see A-2 in the
  skeptic pass below). There is no admin UI or export tool yet to enforce this mechanically; until
  one exists, this is a manual-process requirement on whoever queries Firestore directly.
- A transactional-email-sender choice for double opt-in (separate, smaller dependency decision).
- A `docs/terms.html` clause (drafted, held for legal review before either kill switch flips to `true`).
- New, separate Firestore `leads` collection — not linked to the existing anonymous `diagram_logs`.

## Post-merge independent QC (2026-07-05)

An independent skeptic-cert pass re-validated all 5 original findings against the actual shipped
code (not the self-reported PR reviews) after all 4 build specs merged. Verdict: no CRITICAL
reopened, but 2 of 5 findings were closed only on the path originally named, with an unaddressed
sibling path of the identical failure class:
- **A-1** (rate-limit/cost-guard): closed on the `lead_capture` write path; the `lead_confirm` GET
  read path had zero rate limiting — fixed as a follow-up (see rate-limit keyspace note above).
- **A-4** (kill switch): closed on the backend; the frontend widget rendered unconditionally
  regardless of the backend flag (a static site can't read a server env var) — fixed via the new
  `LEAD_CAPTURE_UI_ENABLED` flag above. No data was ever at risk (submissions still hit the
  disabled backend and failed), but the ADR's original claim that one flag gated both was wrong.
- **A-2**'s residual (no code/doc-level "only contact confirmed leads" guardrail) — addressed by
  the operational-guardrail note above; still not mechanically enforced (no admin UI exists).
- **A-3** and **A-5** were confirmed genuinely closed, no changes needed.
