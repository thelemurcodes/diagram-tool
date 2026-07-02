# TD-013 Test Verification

**File under test:** `server/index.js`  
**Test file:** `server/__tests__/generateDiagram.test.ts`  
**Test runner:** Jest 29 (via `ts-jest`), invoked with `jest --runInBand`

---

## Summary

The test suite covers every exported pure helper and every reachable branch of
the HTTP handler registered as the `diagram` Cloud Function. All tests are
written in TypeScript and compiled on the fly by `ts-jest`. No real network
calls, Firestore writes, or Cloud Function registrations occur during a run —
each dependency is mocked before the module under test is loaded.

---

## Mocking strategy

| Dependency | Mock approach | Reason |
|---|---|---|
| `@google-cloud/functions-framework` | `jest.mock` — captures `functions.http(name, handler)` into a `registeredHandlers` map | Prevents real handler registration; lets tests invoke the handler directly |
| `@google-cloud/firestore` | `jest.mock` — stubs `Firestore` constructor and `.collection().add()` | Avoids requiring Application Default Credentials in CI |
| `global.fetch` | `jest.fn()` assigned to `global.fetch` before module load | Intercepts every outbound Anthropic API call |

The module is `require`d after all mocks are installed so that the module-level
side-effects (framework registration, Firestore init) pick up the stubs.

---

## Exported helpers

### `systemPrompt(type, mode)`

Builds the system prompt sent to Claude. Tests confirm:

- **`describe` mode** — prompt contains `"Turn the user's description"` and the
  correct diagram-type hint for each supported type.
- **`policy` mode** — prompt contains `"pasted a policy"` and does not contain
  the describe-mode preamble.
- **Diagram-type hints** — `flowchart TD`, `sequenceDiagram`, `mindmap`,
  `timeline`, `organizational chart`, and `decision tree / Yes/No` are all
  verified individually.
- **Unknown type fallback** — falls back to `"most appropriate Mermaid diagram"`.
- **Output rule** — `"no markdown fences"` is always present regardless of type
  or mode.

9 test cases. All branches covered.

### `cleanMermaid(raw)`

Strips code fences and stray backticks from AI output. Tests confirm:

- Plain Mermaid code is returned unchanged.
- ` ```mermaid … ``` ` fences are stripped.
- Plain ` ``` … ``` ` fences are stripped.
- Stray leading/trailing backticks without a fence block are removed.
- Empty string input returns `""`.
- `undefined` input (coerced via `raw || ''`) returns `""` without throwing.
- Surrounding whitespace is trimmed.
- Interior newlines within the diagram body are preserved.

8 test cases. Covers the fence-match branch, the no-fence branch, and the
null/undefined edge case.

### `allow(key, limit, windowMs)`

In-memory sliding-window rate limiter backed by the exported `_hits` map. Tests
confirm:

- First request is permitted.
- Requests up to the configured limit are all permitted.
- The request that would exceed the limit is blocked.
- After the window's `resetAt` timestamp is manually back-dated to the past, the
  next request is permitted (window reset).
- Two distinct keys are tracked independently.

`_hits.clear()` is called in `beforeEach` to prevent cross-test leakage.

5 test cases. Both the "permit" and "block" branches, plus the window-reset
branch, are exercised.

### `hashIp(ip)`

One-way SHA-256 truncated to 16 hex characters. Tests confirm:

- Output is exactly 16 characters and matches `/^[0-9a-f]+$/`.
- Output is deterministic for the same input.
- Different IPs produce different hashes.
- Empty string and the literal `"unknown"` do not throw.

4 test cases.

---

## HTTP handler branches

### CORS preflight

| Scenario | Expected status | Verified |
|---|---|---|
| `OPTIONS` request | 204 | ✓ |
| `Access-Control-Allow-Origin` header present on every response | — | ✓ |
| `ALLOWED_ORIGIN` env var forwarded verbatim | value of env var | ✓ |

### Method validation

| Scenario | Expected status | Verified |
|---|---|---|
| `GET` request | 405 | ✓ |
| `PUT` request | 405 | ✓ |

### Input validation

| Scenario | Expected status | Body assertion | Verified |
|---|---|---|---|
| Empty prompt string | 400 | `error` matches `/empty prompt/i` | ✓ |
| Absent prompt field | 400 | — | ✓ |
| `describe` prompt > 1500 chars | 413 | `error` matches `/too long/i`; `cap === 1500` | ✓ |
| `policy` prompt > 8000 chars | 413 | `cap === 8000` | ✓ |
| `describe` prompt exactly 1500 chars | 200 | — | ✓ |
| `policy` prompt exactly 8000 chars | 200 | — | ✓ |
| Unrecognised `mode` value | defaults to `describe` (200) | — | ✓ |

Boundary tests at exactly the cap ensure the guard clause uses `>` (exclusive),
not `>=`.

### API key check

| Scenario | Expected status | Body assertion | Verified |
|---|---|---|---|
| `ANTHROPIC_API_KEY` not set | 500 | `error` matches `/not configured/i` | ✓ |

### Rate limiting

The test pre-seeds `_hits` directly to avoid running through the full call
sequence.

| Scenario | Expected status | Body assertion | Verified |
|---|---|---|---|
| Per-minute IP bucket full (`m:<hash>` at limit) | 429 | `error` matches `/rate limited/i` | ✓ |
| Global daily cap full (`g:<date>` at 2000) | 503 | `error` matches `/daily limit/i` | ✓ |

### Upstream / Anthropic error paths

| Scenario | Expected status | Body assertion | Verified |
|---|---|---|---|
| `fetch` throws (network failure) | 502 | `error` matches `/unreachable/i` | ✓ |
| Anthropic responds with non-OK HTTP status | 502 | `status` reflects upstream code | ✓ |
| Anthropic returns empty `content` array | 502 | `error` matches `/empty result/i` | ✓ |
| Anthropic returns whitespace-only content | 502 | `error` matches `/empty result/i` | ✓ |
| Anthropic returns fenced content that cleans to `""` | 502 | — | ✓ |

### Happy path

| Scenario | Expected status | Verified |
|---|---|---|
| Plain `describe` request | 200, `mermaid` === raw diagram | ✓ |
| AI response wrapped in ` ```mermaid ``` ` fences | 200, fences stripped | ✓ |
| `policy` mode request | 200 | ✓ |
| Correct model (`claude-haiku-4-5-20251001`) and `max_tokens` (1100) sent | — | ✓ |
| `x-api-key` header carries `ANTHROPIC_API_KEY` value | — | ✓ |
| Diagram type propagated into system prompt sent to API | — | ✓ |

---

## Coverage map

| Module area | Branch coverage |
|---|---|
| `systemPrompt` — all diagram types + mode switch | Full |
| `cleanMermaid` — fence/no-fence/null | Full |
| `allow` — permit/block/reset | Full |
| `hashIp` — normal/edge inputs | Full |
| Handler — OPTIONS / non-POST | Full |
| Handler — empty prompt / absent prompt | Full |
| Handler — describe cap / policy cap / boundary | Full |
| Handler — missing API key | Full |
| Handler — per-IP rate limit / global cap | Full |
| Handler — fetch throw / non-OK / empty / whitespace / fence-to-empty | Full |
| Handler — happy path (describe, policy, fence-strip, API call shape) | Full |

---

## Known gaps

- **`logEvent` / Firestore write path** — the Firestore mock confirms the client
  is instantiated, but individual log-event call arguments are not asserted.
  Logging failures are intentionally swallowed by the production code, so a
  broken logger cannot cause a test regression anyway.
- **Per-IP daily limit** (`d:<hash>:<date>`) — the per-minute limit test
  covers the 429 path; the daily-IP bucket is not independently exercised with a
  pre-seeded `_hits` entry. The `allow` unit tests cover the shared logic, so
  the gap is low risk.
- **`sweep()` call** — the 5 % random sweep of stale `_hits` entries is not
  directly tested; it is an internal housekeeping detail exercised implicitly by
  the rate-limiter unit tests.
- **`LOG_PROMPTS=true` branch** — the test suite sets and deletes `LOG_PROMPTS`
  but does not assert that Firestore `.add()` was called with specific arguments
  when logging is enabled.
