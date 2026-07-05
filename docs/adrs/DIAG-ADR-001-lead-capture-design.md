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

- `LEAD_CAPTURE_ENABLED` env var (default `false`) gates the new endpoint and the frontend widget.
- New `lead:${ipHash}` rate-limit keyspace + a hard daily Firestore-write cap on the `leads` write path.
- A transactional-email-sender choice for double opt-in (separate, smaller dependency decision).
- A `docs/terms.html` clause (drafted, held for legal review before the kill switch flips to `true`).
- New, separate Firestore `leads` collection — not linked to the existing anonymous `diagram_logs`.
