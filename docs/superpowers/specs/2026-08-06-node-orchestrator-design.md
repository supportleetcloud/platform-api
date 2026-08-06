# Node Orchestrator — Design

> Subsystem #3 of the platform (see `PLANO_MVP.md`). Wires the Node backend (already has auth/session/User from the Foundation plan) to the Java validation engine (already exposes `POST /runs` and pushes results via webhook — see `docs/superpowers/specs/2026-08-03-validation-engine-design.md`). Adds the challenge catalog, run submission, result delivery, and free-tier gating. Does **not** cover billing/Stripe, the admin panel, AI feedback, or rate limiting — those are separate future plans.

## Goal

Let a logged-in user pick a challenge, submit their API's URL, have the Java engine run it, and see the score/result — with the free-tier attempt limits enforced and the webhook callback from Java authenticated so results can't be forged.

## Scope (this plan)

In scope:
- Challenge catalog: static YAML files in the repo, seeded into Postgres as metadata, served via a list/get API.
- Run submission (`POST /api/runs`): validates input, enforces free-tier limits, calls the Java engine, persists a `Run` row.
- Webhook receiver (`POST /api/webhooks/runs/:jobId`): authenticated via a per-job token, updates the `Run` row.
- Polling (`GET /api/runs/:id`): owner-only, computes a `timed_out` display status for stale pending runs.
- Free-tier gating: 2 challenges auto-locked on first attempt, 10 attempts each — enforced against a `User.isPaid` stub field.

Explicitly out of scope (deferred to other plans): Stripe/billing (the `isPaid` field is a stub, always `false` until the billing plan wires it up), admin panel (price/ToS config), AI feedback engine, ranking/public profile, rate limiting on submission, and any change to the `validation-engine` (Java) module — this plan integrates with it as-is.

## Architecture

Thin orchestrator, matching `PLANO_MVP.md`'s architecture section and the webhook-push design the Java module already implements (no queue/broker in v1):

```
Node (backend/)                          Java (validation-engine/)
  POST /api/runs  ────────────────────►    POST /runs
  (creates Run row, status=pending)        (202 immediately, runs in background)
                                                    │
  POST /api/webhooks/runs/:jobId  ◄────────────────┘
  (updates Run row)                        (webhook callback on completion)

  GET /api/runs/:id  ◄── polled by frontend
```

Two alternatives considered and rejected:
- **Queue/broker (Redis, BullMQ) between Node and Java** — `PLANO_MVP.md` explicitly excludes a message queue from v1.
- **Node polls Java instead of receiving a webhook** — would require a new `GET /runs/:id` on the Java side and discarding the already-implemented `WebhookNotifier`. No benefit, pure rework.

## Data Model (additions to `backend/prisma/schema.prisma`)

```prisma
model Challenge {
  id        String   @id                 // slug, e.g. "todo-api-crud"
  title     String
  category  String                       // crud | contract | status-headers | auth
  points    Int                          // sum of checks[].points, cached for listing
  yamlPath  String                       // path relative to backend/challenges/
  createdAt DateTime @default(now())

  runs Run[]
}

model Run {
  id            String   @id @default(uuid())   // == jobId sent to Java
  userId        String
  challengeId   String
  targetUrl     String
  status        String   @default("pending")    // pending | completed | error
  score         Int?
  checks        Json?                           // raw ScoreCalculator.CheckResult[] from Java
  error         String?
  callbackToken String                           // per-job webhook secret, see below

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user      User      @relation(fields: [userId], references: [id])
  challenge Challenge @relation(fields: [challengeId], references: [id])

  @@index([userId, challengeId])
}
```

`User` gains `isPaid Boolean @default(false)`.

`timed_out` is **not** a stored status — it's computed at read time in `GET /api/runs/:id` (see below) so a late webhook can still land correctly.

Attempt counts and "which 2 challenges are locked in" are **not** materialized columns — they're derived with `SELECT DISTINCT challengeId` / `COUNT(*) ... GROUP BY` queries against `Run` at gating time. Less state to keep in sync, and gating only runs on the (low-frequency) submission path.

## Challenge Catalog

**Storage:** `backend/challenges/*.yaml` — 5-8 files, same grammar the Java engine parses (`id`, `title`, `category`, `checks`, optional `openapiSpec`). Authored by the team, versioned in the repo, no admin-UI editing (the MVP admin panel only covers price + ToS).

**Seeding:** `backend/scripts/seed-challenges.ts` reads each YAML file, sums `checks[].points`, and upserts a `Challenge` row by `id`. Run manually (`npm run seed:challenges`) or as a deploy step — **not** on every app boot, to avoid re-parsing YAML per request/restart and racing across instances.

**Endpoints:**
- `GET /api/challenges` — public (no `requireAuth`), returns `{id, title, category, points}[]`.
- `GET /api/challenges/:id` — public, same fields for one challenge. Does **not** return the raw `checks` YAML — showing the exact assertions would let users optimize for the test instead of building the real thing.

**Cross-module coupling to flag:** when a check uses `openapiSpec` or `jsonSchema`, the Java engine resolves that path via **its own classpath** (`getResourceAsStream`/`getResource`), not from the YAML text that travels in the request body. Those support files must physically exist under `validation-engine/src/main/resources/` — today they only exist under `src/test/resources/`. For every launch challenge that references one, the corresponding OpenAPI/JSON-Schema file needs to be copied into `validation-engine/src/main/resources/` as part of this plan's implementation (a manual sync between two repos' worth of files — no clean way to avoid it without Node serving those files to Java over HTTP, which is unnecessary complexity for v1).

## Run Submission (`POST /api/runs`)

**Auth:** `requireAuth`.

**Body:** `{ challengeId, targetUrl, confirmedAuthorization: boolean }`. `confirmedAuthorization` is the mandatory checkbox from `PLANO_MVP.md` ("user confirms they own or are authorized to test the given URL"). `400` if it's not `true`, if `challengeId` doesn't exist, or if `targetUrl` isn't a well-formed `http(s)://` URL (shape validation only — real SSRF defense is the Java engine's `SsrfGuard`, not duplicated here).

**Free-tier gating** (skipped entirely if `user.isPaid`):
1. `SELECT DISTINCT challengeId FROM Run WHERE userId = X`. If the requested `challengeId` isn't in that set and the set already has 2 distinct challenges → `403`.
2. `SELECT COUNT(*) FROM Run WHERE userId = X AND challengeId = Y`. If `>= 10` → `403`.

**Webhook authentication:** a per-job token, not a change to the Java module. Node embeds it as a query-string param in the `webhookUrl` it hands to Java: `${WEBHOOK_BASE_URL}/api/webhooks/runs/${jobId}?token=${callbackToken}`. The Java `WebhookNotifier` already `POST`s to whatever `webhookUrl` it's given — no code change needed there. Trade-off: the token can appear in access logs (not in any body/header) — acceptable for v1 since it only protects the integrity of a `Run` whose `id` is already an unguessable UUID, not a credential for anything else.

**Flow:**
1. Validate + gate as above.
2. Read the YAML file at `challenge.yamlPath` from disk.
3. Generate `jobId = randomUUID()`, `callbackToken = randomBytes(24).toString('hex')`.
4. Insert `Run` row (`id = jobId`, `status = 'pending'`, `callbackToken`).
5. `POST` (short timeout, ~5s) to `${VALIDATION_ENGINE_URL}/runs` with `{jobId, targetUrl, challengeYaml, webhookUrl}`. Java responds fast (just schedules on its executor) — this call does not wait for the challenge to actually run.
   - Failure to reach Java (network error, timeout, non-2xx) → set `Run.status = 'error'`, `error = 'failed to reach validation engine'`, respond `502`.
   - Success → respond `202 { runId: jobId, status: 'pending' }`.

## Webhook Receiver (`POST /api/webhooks/runs/:jobId`)

No `requireAuth` — the caller is the Java engine, not a logged-in user. Authenticated via the `token` query param instead.

**Body** (matches `RunResult.java`, which omits null fields): `{jobId, status: "completed"|"error", score?, checks?, error?}`.

**Steps:**
1. `SELECT * FROM Run WHERE id = :jobId`. Not found → `404`, log warn.
2. Compare `req.query.token` to `run.callbackToken` with `crypto.timingSafeEqual` (not `===`) → mismatch is `403`, log warn as a possible forged webhook.
3. **Idempotency:** if `run.status !== 'pending'` already, respond `200` without reprocessing.
4. Validate `body.status` is `"completed"` or `"error"` → otherwise `400`.
5. Update `Run`: `status`, `score ?? null`, `checks ?? null`, `error ?? null`.
6. Respond `200` (empty body — the Java `WebhookNotifier` discards the response body anyway).

No cross-check of `body.jobId` against the path param — the path is already the authenticated source of truth via the token.

## Polling (`GET /api/runs/:id`)

**Auth:** `requireAuth` + ownership check — `run.userId !== req.user.id` → `404` (not `403`, to avoid confirming the run's existence to a non-owner).

**Stale timeout, computed on read, not stored:** if `status === 'pending'` and `now - createdAt > RUN_TIMEOUT_MS` (new env var, default `300000` = 5 minutes), the response reports `status: "timed_out"` without writing that to the database. The DB row stays `pending`; if the webhook arrives late (Java stalled, not dead), it still overwrites to the real `completed`/`error` and the next read reflects that.

**Response:** `{runId, challengeId, targetUrl, status, score, checks, error, createdAt}`.

## Config

New env vars in `backend/.env.example`:
- `VALIDATION_ENGINE_URL` — e.g. `http://localhost:8080`.
- `WEBHOOK_BASE_URL` — must be reachable **by the Java service**; in production this is Node's public URL, not `localhost`.
- `RUN_TIMEOUT_MS` — default `300000`.

## Error Handling

No new global error-handling middleware — follows the existing per-route try/catch + `{error: "message"}` JSON response pattern already used in `backend/src/auth/routes.ts`. A failure to read a challenge's YAML file off disk (missing/corrupt file) is a `500`, logged with the `challengeId` for debugging.

## Testing Strategy

Same pattern as the existing suite (`backend/tests/*.test.ts`, Jest + Supertest against `createApp`, Prisma injected via `deps`):

- `challenges.routes.test.ts` — list/get return metadata only, never the raw check YAML.
- `seed-challenges.test.ts` — YAML parses, `points` sums correctly, upsert is idempotent.
- `runs.routes.test.ts` (POST) — happy path persists `Run` and calls the (mocked) Java engine; free-tier gating blocks a 3rd distinct challenge and an 11th attempt; missing `confirmedAuthorization` is rejected; unreachable Java engine produces `502` + `Run.status = 'error'`.
- `webhooks.routes.test.ts` — correct token updates `Run`; wrong token is `403`; unknown `jobId` is `404`; a second callback for an already-resolved run is a no-op.
- `runs.routes.test.ts` (GET) — owner sees the run; non-owner gets `404`; an old `pending` run reports `timed_out` without the DB row changing.

## Open Items for the Implementation Plan

- Exact shape of the `checks` JSON column validation (whether Node validates the Java payload's `checks` array shape beyond "is an array," or trusts it as-is since both services are first-party).
- Whether `seed-challenges.ts` runs via `ts-node` directly or gets compiled — follow whatever convention the existing `backend/package.json` scripts already use.
- Copying the launch challenges' `openapiSpec`/JSON-Schema support files into `validation-engine/src/main/resources/` is listed here as a known requirement; the implementation plan should turn it into an explicit task once the actual 5-8 launch challenges are chosen.
