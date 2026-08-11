# EyeSection Backend — Production-Readiness Report

*Generated 2026-08-11 · Scope: `server/` (Node 20 · Express 4 · TypeScript · MongoDB/Mongoose 8 · Redis/BullMQ 5 · S3 · OpenAI · Firebase)*

---

## 1. Overall verdict

This is a genuinely well-engineered backend — much better than typical pre-launch code. It already has:

- Readiness/liveness probes (`/health`, `/ready` with real Mongo + Redis pings)
- Graceful shutdown with a 10s force-exit fallback, process guards (`unhandledRejection` survives, `uncaughtException` exits clean)
- **Redis-backed** rate limiting (shared across instances, not in-memory)
- All heavy AI/image work offloaded to BullMQ queues, never in the HTTP request
- Zod-validated env config that fail-fasts on bad config and hard-fails in prod on the default admin secret
- Strict `json_schema` AI outputs + Zod re-validation (two layers)
- EXIF stripping, scoped body limits (12mb only on `/scans`, 256kb elsewhere), clean error masking in prod
- Good secrets hygiene: `.env` and `firebase-service-account.json` are gitignored and confirmed absent from git history

**Verdict: production-ready for a modest launch, but not yet safe or scalable for serious traffic** — two high-severity auth bugs, several cost/abuse races around the OpenAI pipeline, and missing operational tooling need fixing first.

---

## 2. Capacity — how many users can it handle?

The bottleneck is **not** the Node tier — it's the OpenAI pipeline and CPU-bound image work.

Per single instance with default settings:

| Path | Capacity | Limiting factor |
|---|---|---|
| Scan analysis | ~1 scan/sec sustained (~3,600/hr) | `ANALYZE_CONCURRENCY=10` × ~10s per 3-call GPT ensemble |
| Scan uploads | ~8–20/sec | sharp re-encode of up-to-12MB images on a 4-thread libuv pool |
| Light API (auth, polling, progress) | thousands of req/min | Mongo round-trips |

In practice one instance comfortably serves roughly **1,000–5,000 concurrent active users / tens of thousands of DAU** for an app where scans are occasional — scan bursts queue up rather than fail.

**Horizontal scaling: yes, the app is effectively stateless.** JWT sessions (no session store), Redis-shared rate limits and quotas, BullMQ-deduplicated cron jobs, health probes for LB integration. Scale by adding replicas and running `WORKER_MODE=separate` so the HTTP and worker tiers scale independently.

The real ceiling then becomes **OpenAI RPM/TPM limits and cost**: each scan fires 3 parallel vision calls (up to 6 on a retry round) plus 1 text call, ~5k+ input tokens/scan minimum. There is **no BullMQ `limiter`** on the analyze queue, so adding worker replicas multiplies concurrent OpenAI calls (default peak: `ANALYZE_CONCURRENCY 10 × SAMPLES 3 = 30` per worker).

---

## 3. Security findings (ranked)

### HIGH

**H1 — Suspension/revocation bypass** · `src/services/auth.service.ts:136-189`
`login()` and `socialLogin()` never check `user.status === 'suspended'`. The revocation blocklist (set on admin suspend and GDPR delete) is only consulted in the *refresh* flow. A suspended user simply logs in again and receives fresh 15-min access + 30-day refresh tokens. Access tokens are also never checked against the blocklist, so even the refresh-path revocation has up to a 15-minute lag.
**Fix:** check `status` in login/socialLogin; check the blocklist in the auth middleware (or shorten access TTL).

**H2 — Admin login brute-forceable** · `src/app.ts:109`, `src/routes/admin.routes.ts:9`
User auth routes get the strict limiter (10/min/IP), but `/admin` is mounted with only `defaultRateLimit` (100/min/IP) and `POST /admin/auth/login` sits above `requireAdmin`. No lockout, no backoff. The highest-value endpoint has the weakest protection.
**Fix:** apply `authRateLimit` (or stricter) to admin auth routes + per-account lockout/backoff.

### MEDIUM

**M1 — Free-scan quota race (TOCTOU)** · `src/services/scan.service.ts:60-77, 137-207`
`countDocuments` → (image processing, S3 upload) → `create` is check-then-act. Two concurrent uploads from the same free user both pass the `FREE_SCAN_LIMIT=1` check → OpenAI cost abuse. The purely-anonymous path is safe (atomic Redis `INCR`); the registered-free path is not.
**Fix:** atomic reservation (Redis INCR with rollback, mirroring the anon path).

**M2 — RevenueCat webhook: non-atomic + weak idempotency** · `src/services/subscription.service.ts:129-174`
Read-modify-write with no locking; duplicate/concurrent deliveries can interleave and lose updates. Idempotency is keyed only on `event_timestamp_ms` — events without a timestamp always reprocess. No per-event-ID dedupe.
**Fix:** per-event-ID dedupe (Redis SETNX w/ TTL) + `findOneAndUpdate` with conditional guards.

**M3 — Password-reset weaknesses** · `src/services/auth.service.ts:209-233`
- Reset token written to server logs in cleartext (`:217`)
- Token replayable for its full 30-min TTL (not single-use)
- Existing sessions not revoked after a successful reset
- Signed with `JWT_SECRET` (shared with access tokens) rather than an isolated secret

**M4 — Rate limiter fails open, IP-only** · `src/middleware/rateLimit.ts:37-41`
Any Redis error → request allowed. Combined with H2/M1, a Redis blip removes brute-force and cost protection. No per-account dimension, so distributed brute force across IPs is unmitigated.

### LOW / informational

- **L1** Anonymous scans readable by anyone with the scanId (`scan.service.ts:247-251`); ObjectIds are partially predictable. Consider binding anon scans to the anonymous token.
- **L2** Admin user search passes raw input to `$regex` (`admin.service.ts:244`) — ReDoS; admin-only. General Mongo operator injection is otherwise well-contained (Zod everywhere it matters).
- **L3** `fcmTokens` array is deduped but uncapped (`models/User.ts:141`).
- **L4** Password policy is only min-8 characters.
- **L5** GDPR deletion cascade is otherwise complete (Mongo + S3 prefix + cache + token revoke) but `AdminNotificationLog.userId` retains deleted users' IDs; pre-deletion access tokens stay valid ≤15 min.

### Secrets audit

`.gitignore` excludes `.env`, `firebase-service-account.json`, `*.pem`; `git ls-files` confirms only `.env.example` (empty placeholders) is tracked — nothing in history. **However, the working tree holds real live credentials** (Mongo URI, AWS key pair, OpenAI key, three 64-char JWT secrets, RevenueCat webhook auth, Firebase private key). If this folder has ever been zipped, shared, or synced anywhere, **rotate all of them**.

---

## 4. AI pipeline assessment — is it a decent choice?

**Yes — the architecture is notably good.** OpenAI-only via the official SDK: a vision model (`OPENAI_MODEL`) for eye-area appearance grading, a text model (`OPENAI_TEXT_MODEL`) for routine tips + chat.

**What's done right:**

- Fully **queued** (BullMQ `analyze-eye-scan`, concurrency 10, 3 attempts, exp backoff); clients poll `GET /scan/:id` with an FCM push as a nudge.
- **3-sample vision ensemble** (`Promise.allSettled`, averaged), with **confidence computed from cross-sample agreement** (1 − 2×stddev), not model self-report — a genuinely smart robustness technique. Low-agreement ensembles get down-weighted in scoring (trust floor 0.6).
- Only the **eye crop** (≤1024px JPEG q90) is sent to the model, not the full face — cheaper, more private. Raw photos auto-delete within 24h; clients only ever receive the eye-crop thumbnail.
- **Strict `json_schema` (`strict:true`) + Zod re-validation.** Malformed responses degrade to fewer samples, never crash.
- **Hybrid code+model scoring:** LAB color analysis (dark-circle L-delta, redness a-delta, Laplacian texture energy for fine lines, radiance) computed deterministically with sharp; blended with the model read. Freshness score, iris classification, and all thresholds are pure code — explainable and free.
- **Strong medical guardrails** in every prompt ("appearance only, never diagnose"), plus a fixed medical-redirect line in chat; user free-text is sanitized before prompt injection in the routine flow.
- **Graceful degradation everywhere:** code-only fallback when no API key; refuses to persist fallback results when a key *is* configured (503 instead of silently degraded data); provider errors never reach users; thumbnail failures never fail the scan; full rollback (Mongo doc + S3 objects) if ingestion fails partway.
- **Cost gates:** free/anon = 1 scan; anonymous per-IP daily cap (atomic Redis); chat capped 3/day free, 12/day premium, with rejected turns costing no tokens.

**Gaps (cost/latency controls, not architecture):**

1. **No timeout on any OpenAI call** — SDK default is 10 minutes, and BullMQ retries 3×. Worst case a stuck job holds a worker slot for ~30 min. → Set `timeout` (~60s) and explicit `maxRetries` on the client.
2. **No `max_tokens`** on chat or routine completions — output cost is unbounded.
3. **Retries re-bill everything:** an infra failure (S3/Mongo) *after* grading re-runs all GPT calls on the next BullMQ attempt — no memoization of the vision result — and may produce a *different* result. → Persist the ensemble result keyed by scanId before the fallible persistence steps.
4. **LAB and GPT run sequentially** (`pipeline.service.ts:87-88`) despite the docstring saying "in parallel" — free latency win with `Promise.all`.
5. **Chat trusts client-supplied history**, including forged `assistant` turns (`chat.controller.ts:6`, `chat.service.ts:371`) — a malicious client can inject fake assistant messages to erode the medical guardrails. Blast radius is the user's own session. **Chosen fix: sanitize client history server-side** (sanitize all message content, cap lengths, harden the system prompt to distrust prior turns) — keeps the API contract, no Flutter changes.
6. **Threshold calibration is circular** — `calibrateThresholds.ts` tunes severity cutoffs to agree with the model's own stored outputs, not ground truth. Fine as a consistency tool; don't treat it as validation.
7. **Routine generation is uncached** — an extra text call on every scan even when inputs barely changed.
8. Fragility note: `JSON.parse` in `gpt.service.ts:169` is unguarded — currently safe only because `Promise.allSettled` catches the throw; a refactor to `Promise.all` would break it.
9. `getObjectBuffer` loads full images into memory; at concurrency 10 that's ~10 full images decoded simultaneously in the worker. Acceptable now, watch memory if concurrency rises.

**Cost per scan (derived):** 3 vision calls (~1,000 image tokens + ~600 prompt tokens each at `detail:'high'` ≤1024px) + 1 text call ≈ **5k+ input tokens minimum**, up to 2× on a retry round, plus unbounded output until `max_tokens` is set.

---

## 5. Scalability & operations gaps

1. **Single process, no clustering** — one core per instance; nothing bundled (no pm2). Fine on Railway with replicas, but document it.
2. **Mongo connection unconfigured** (`config/db.ts:14`) — default `maxPoolSize=100` per process, no `serverSelectionTimeoutMS`/`socketTimeoutMS`. Tune to your Atlas tier × replica count.
3. **No BullMQ `limiter`** on any queue — worker replicas multiply OpenAI concurrency unchecked.
4. **Unbounded maintenance-job queries** — `retention.job.ts:12`, `anonCleanup.job.ts`, `weeklyReport.job.ts` load entire result sets into memory, then process one-by-one. Fine now; memory spike on a large backlog. Use `.limit()` batches or cursors.
5. **No `compression` middleware** — uncompressed JSON responses.
6. **Plain-text console logging** (`utils/logger.ts` — the file itself says "swap for pino later") — no structured logs, no request-scoped context beyond the request ID.
7. **Zero metrics** — no `/metrics`, no prom-client/OTel. You would debug production incidents blind. Health probes are the only signal.
8. **Load test covers ingestion only** (`loadtest/scan-loadtest.ts` — well-built: stubbed S3, throwaway DB, p50/p90/p99 at concurrency 50–300) but no results are recorded anywhere, and the analysis path (the actual bottleneck) is untested.
9. **README has no deployment guidance** — no mention of `WORKER_MODE=separate`, replicas, or sizing.
10. Rate limiting is fixed-window (2× burst possible at window boundaries) — acceptable; note it.

---

## 6. Prioritized roadmap

**Phase 1 — before real users (security criticals)**
1. H1: check `status==='suspended'` in `login`/`socialLogin`; check the revocation blocklist in the access-token auth middleware.
2. H2: `authRateLimit` + per-account lockout/backoff on admin login.
3. M3: stop logging reset tokens; make them single-use (jti in Redis); revoke sessions on reset; dedicated reset secret.

**Phase 2 — cost protection**
4. M1: atomic scan-quota reservation (Redis INCR + rollback, like the anon path).
5. M2: webhook per-event-ID dedupe + atomic `findOneAndUpdate`.
6. OpenAI client `timeout` (~60s) + `maxRetries`; `max_tokens` on chat and routine calls.
7. Memoize the vision ensemble result across BullMQ attempts.

**Phase 3 — quality & throughput**
8. Sanitize client-supplied chat history (chosen approach — no API change).
9. `Promise.all` for LAB + GPT in the pipeline.
10. BullMQ `limiter` on the analyze queue; tune Mongo pool + timeouts.
11. Cache/skip routine generation when scan inputs are similar.

**Phase 4 — ops polish**
12. pino structured logging; `compression`; basic `/metrics` (prom-client).
13. Batch/cursor the maintenance jobs.
14. README deployment docs: `WORKER_MODE=separate`, replica guidance, env knobs, recorded load-test numbers.
15. Guard the `JSON.parse` in `gpt.service.ts`; cap `fcmTokens`; escape admin search regex; strengthen password policy.

---

*Compiled from a three-track review: infrastructure/scalability, AI pipeline, and security/correctness. File references are to `src/` paths at the time of review.*
