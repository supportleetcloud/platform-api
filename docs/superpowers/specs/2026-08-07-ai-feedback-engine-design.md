# AI Feedback Engine + LLM Admin Config — Design

> Subsystem #5 of the platform (see `PLANO_MVP.md`, "AI Feedback Engine"). Builds on the Node orchestrator (`docs/superpowers/specs/2026-08-06-node-orchestrator-design.md`) and the frontend challenge flow (`docs/superpowers/specs/2026-08-07-frontend-challenge-flow-design.md`) — both already implemented. Adds one LLM-generated feedback text per completed `Run`, plus the first slice of the Painel Admin module (a screen to configure which LLM provider/model/credentials generate that feedback). Does **not** cover subscription pricing, Terms of Service, Stripe/billing, or ranking/public profile — those are separate future work.

## Goal

Every completed run gets one LLM-generated feedback text, written from the structured check results. Free-tier users only see the feedback for their single most recent completed run across all challenges; paid users see the full history. The LLM provider, model, and credentials are configured by an admin at runtime — not hardcoded — supporting Claude, OpenAI, OpenRouter, and Ollama.

## Scope

In scope:
- `LlmSettings`: a singleton admin-configured record (`provider`, `model`, `baseUrl`, encrypted `apiKey`) — `GET`/`PUT /api/admin/llm-settings`, admin-only.
- `requireAdmin` middleware — the first admin-gated route in the codebase.
- Feedback generation: one LLM call per completed `Run`, fired asynchronously after the webhook responds, using whichever provider/model the admin has configured.
- Free/paid gating of feedback *display* (not generation — generation always happens per `PLANO_MVP.md`).
- Frontend: `/admin/llm-settings` config page; `/runs/[id]` extended to show feedback (or a paywall/locked message) once ready.

Explicitly out of scope: price/ToS admin screens (a separate Painel Admin item), Stripe/billing (the `isPaid` field is a stub, always `false`, as established by the Node orchestrator plan), ranking/public profile, and any change to the `validation-engine` (Java) module.

## Architecture

```
Java validation-engine ──webhook──► Node webhook handler
                                       │ 1. update Run: status=completed, feedbackStatus=pending
                                       │ 2. respond 200 immediately (no LLM wait)
                                       │ 3. fire-and-forget: generateFeedbackForRun(runId)
                                       │        │
                                       │        ├─► load LlmSettings (decrypt apiKey)
                                       │        ├─► call the configured provider (fetch, ~30s timeout)
                                       │        └─► update Run: feedback=text, feedbackStatus=ready|failed
                                       ▼
                                  GET /api/runs/:id ◄── polled by frontend, now also polls
                                                         past 'completed' while feedbackStatus
                                                         is still 'pending'
```

Two alternatives considered and rejected:
- **Generate feedback synchronously inside the webhook handler, before responding** — ties the webhook's response latency (and the Java engine's perceived reliability) to whichever LLM provider is configured, which can be slow or rate-limited. Rejected per explicit preference: keep the webhook fast, let feedback resolve independently.
- **Store provider API keys in environment variables instead of the database** — simpler, no encryption needed, but not switchable without a redeploy. Rejected per explicit preference for an admin-configurable, no-redeploy provider switch.

## Data Model (additions to `backend/prisma/schema.prisma`)

```prisma
model LlmSettings {
  id               String   @id                  // always the literal string "singleton"
  provider         String                         // "claude" | "openai" | "openrouter" | "ollama"
  model            String                         // free text — see "Model field" below
  baseUrl          String?                        // ollama only, e.g. "http://localhost:11434"
  apiKeyEncrypted  String?                        // AES-256-GCM, format "<iv>:<authTag>:<ciphertext>" (base64 each); null for ollama
  updatedAt        DateTime @updatedAt
}
```

`Run` gains two columns:

```prisma
model Run {
  // ...existing fields unchanged...
  feedback       String?
  feedbackStatus String  @default("not_applicable")  // not_applicable | pending | ready | failed
}
```

`feedbackStatus` transitions: created as `not_applicable` (matches the existing `status: "pending"` default — a run that hasn't resolved yet has no feedback question to answer). On the webhook's `completed` transition, set to `pending` in the same update that sets `status: "completed"`. On an `error` transition, left as `not_applicable` (no feedback is generated for failed runs — see "Error runs" below). `generateFeedbackForRun` resolves it to `ready` (with `feedback` populated) or `failed` (feedback stays `null`) — always one of those two, never left at `pending` indefinitely, because the provider call carries a hard timeout (see "Provider calls" below).

## Model field: how it satisfies "select which provider is used" for OpenRouter/Ollama

`LlmSettings.model` is free text, validated only for non-emptiness. This single field is deliberately how the "which underlying provider" selection for OpenRouter and Ollama is expressed, rather than a second dropdown:

- **OpenRouter** model ids are themselves namespaced by the underlying provider — `anthropic/claude-3.5-sonnet`, `openai/gpt-4o`, `meta-llama/llama-3.1-70b-instruct`, etc. Typing the id *is* selecting the provider.
- **Ollama** has no concept of "provider" beyond whichever model is pulled on the box at `baseUrl` — the model name (`llama3.1`, `mistral`, `deepseek-r1`) is the only selector that exists.

No curated dropdown list is maintained for any of the four providers — OpenRouter's catalog alone is hundreds of entries and changes continuously; a hardcoded list would need constant upkeep. The admin is trusted to type a valid id for the provider they picked.

## `LlmSettings` — encryption

`apiKeyEncrypted` uses AES-256-GCM via Node's built-in `crypto` module (no new dependency). The encryption key is `ENCRYPTION_KEY` (new env var, 32 raw bytes, base64-encoded in the env value) — set at deploy time, never stored in the database, never returned by any API response.

```ts
// backend/src/llm/settings.ts
export function encrypt(plaintext: string): string   // "<ivB64>:<authTagB64>:<ciphertextB64>"
export function decrypt(ciphertext: string): string
```

`GET /api/admin/llm-settings` never returns the decrypted key or the ciphertext — it returns `apiKeySet: boolean` (whether a key is currently stored) alongside `provider`, `model`, `baseUrl`. `PUT` accepts an optional `apiKey`: omitted or empty string means "keep the currently stored key unchanged" (lets an admin edit `model` without re-pasting the key every time); a non-empty value replaces it.

**Validation on `PUT`:** `provider` must be one of the four known values. `ollama` requires `baseUrl`, must not send `apiKey`. `claude`/`openai`/`openrouter` require an `apiKey` — either newly provided on this request, or already present from a prior save (a first-ever save for one of these three with no key and none on file is a `400`).

**`GET` before any save exists:** the singleton row doesn't exist until the first `PUT`. `GET` returns `200 { provider: null, model: null, baseUrl: null, apiKeySet: false }` rather than a `404` — there's nothing wrong with the request, the platform simply has no LLM configured yet (matches the behavior of `generateFeedbackForRun`, which treats "no `LlmSettings` row" as a normal, expected `failed` outcome, not an error condition).

## Admin Access (`requireAdmin`)

First admin-gated route in the codebase. `User.isAdmin` already exists (Foundation plan's GitHub-username allowlist). New middleware, chained after `requireAuth` (so an unauthenticated request gets `401`, an authenticated non-admin gets `403`):

```ts
// backend/src/admin/middleware.ts
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = req.user as { isAdmin?: boolean } | undefined
  if (!user?.isAdmin) {
    res.status(403).json({ error: 'admin_required' })
    return
  }
  next()
}
```

`backend/src/admin/routes.ts` mounts `GET`/`PUT /api/admin/llm-settings` behind `requireAuth, requireAdmin`.

## Feedback Generation

`backend/src/llm/providers.ts` — one function behind a provider switch, called with the already-decrypted config:

```ts
export type LlmProviderConfig = {
  provider: 'claude' | 'openai' | 'openrouter' | 'ollama'
  model: string
  baseUrl: string | null
  apiKey: string | null
}

export type FeedbackPromptInput = {
  challengeTitle: string
  score: number
  checks: { name: string; status: string; points: number; pointsEarned: number }[]
}

export async function generateFeedback(
  fetchImpl: typeof fetch,
  config: LlmProviderConfig,
  input: FeedbackPromptInput
): Promise<string>
```

One prompt template, shared across all four providers (score + per-check pass/fail + points, asking for a short paragraph of constructive feedback). Per-provider request shape:

- **claude** — `POST https://api.anthropic.com/v1/messages`, `x-api-key`/`anthropic-version` headers, `{model, max_tokens, messages: [{role: 'user', content: prompt}]}`; reads `response.content[0].text`.
- **openai** — `POST https://api.openai.com/v1/chat/completions`, `Authorization: Bearer`, `{model, messages: [{role: 'user', content: prompt}]}`; reads `response.choices[0].message.content`.
- **openrouter** — `POST https://openrouter.ai/api/v1/chat/completions`, same OpenAI-compatible shape and response parsing as `openai`, different base URL and key.
- **ollama** — `POST {baseUrl}/api/generate`, `{model, prompt, stream: false}`; reads `response.response`.

Every call carries a hard timeout (`AbortController`, 30s) — this is what guarantees `feedbackStatus` always resolves out of `pending` (see Data Model).

`backend/src/runs/feedback.ts`:

```ts
export async function generateFeedbackForRun(
  prisma: PrismaClient,
  fetchImpl: typeof fetch,
  runId: string
): Promise<void>
```

Loads the `Run` + its `Challenge` (for the title), loads `LlmSettings` (decrypted) — if none configured, or the provider call throws/times out, catches the error, logs it server-side with the `runId`, and sets `feedbackStatus: 'failed'`. On success, sets `feedback: text, feedbackStatus: 'ready'`.

## Wiring into the webhook

`backend/src/runs/webhook.ts`'s existing `completed`/`error` branch update gains one field, and the handler fires generation without awaiting it:

```ts
await prisma.run.update({
  where: { id: run.id },
  data: {
    status: body.status,
    score: body.score ?? null,
    error: body.error ?? null,
    ...(body.checks !== undefined ? { checks: body.checks } : {}),
    ...(body.status === 'completed' ? { feedbackStatus: 'pending' } : {}),
  },
})

if (body.status === 'completed') {
  generateFeedbackForRun(prisma, fetchImpl, run.id).catch((err) => {
    console.error(`Feedback generation failed for run ${run.id}:`, err)
  })
}

res.status(200).json({ status: 'ok' })
```

`createRunsWebhookRouter` gains a `fetchImpl: typeof fetch` parameter (mirroring `createRunsRouter`'s existing dependency-injection pattern), threaded through from `app.ts`.

## Error runs get no feedback

A `Run` that resolves to `status: 'error'` has no structured check results for the LLM to comment on — only a technical error string (e.g. "failed to reach validation engine"). `feedbackStatus` stays `not_applicable` for these; the frontend shows nothing feedback-related for an errored run.

## Free/Paid Gating

Generation is unconditional — every completed run gets a feedback attempt regardless of `User.isPaid`, per `PLANO_MVP.md` ("dado sempre existe e é armazenado"). Gating is display-only, computed in `getRun`:

```ts
async function isMostRecentCompletedRun(prisma: PrismaClient, userId: string, runId: string): Promise<boolean> {
  const mostRecent = await prisma.run.findFirst({
    where: { userId, status: 'completed' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  return mostRecent?.id === runId
}
```

If `user.isPaid`, feedback is always visible. If not, only the single globally-most-recent completed run (across every challenge, not per-challenge) is visible — everything older is locked. `getRun`'s response includes `feedbackLocked: true` and omits the `feedback` text (even though `feedbackStatus` may be `'ready'` in the database) when the run is locked for this user.

## Polling (`GET /api/runs/:id`) — response shape and frontend stop condition

`GetRunResult`'s `run` object gains:

```ts
feedback: string | null           // null if not yet ready, failed, not_applicable, or locked
feedbackStatus: string            // 'not_applicable' | 'pending' | 'ready' | 'failed'
feedbackLocked: boolean           // true only when feedbackStatus === 'ready' AND the free-tier gate hides it
```

The existing frontend poll-until-terminal logic (`frontend/app/runs/[id]/page.tsx`'s `isTerminal`) stops polling as soon as `status !== 'pending'`. That would stop polling the instant a run hits `completed` — before the async feedback has had a chance to resolve, since generation is fired *after* the webhook response, not before. The stop condition changes to:

```ts
function isTerminal(run: RunStatus): boolean {
  if (run.status === 'pending') return false
  if (run.status === 'completed') return run.feedbackStatus !== 'pending'
  return true // error, timed_out — no feedback is ever expected, stop immediately
}
```

No new frontend-side timeout is needed: the backend's 30s provider-call timeout guarantees `feedbackStatus` always leaves `pending` within a bounded time, so the 2-second poll loop is guaranteed to terminate.

## Frontend

**`/admin/llm-settings`** (new) — fetches `GET /api/me` (existing pattern, `redirectOn401: true`); if `!me.isAdmin`, shows "Not authorized." instead of the form (no redirect — this is an authorization failure, not an authentication one). Form: provider `<select>` (claude/openai/openrouter/ollama), `model` text input, `baseUrl` text input (shown only when provider is `ollama`), `apiKey` password input (labeled "leave blank to keep current key" once `apiKeySet` is true). Submits `PUT /api/admin/llm-settings`; shows the server's `error` message on `400`/`403`, a generic message on other failures/network errors — same pattern as the existing submit form on `/challenges/[id]`.

**`/runs/[id]`** (modified) — once `status === 'completed'` and `feedbackStatus === 'ready'`: render the feedback text under the existing score/checks list. If `feedbackLocked`, render "Upgrade to see feedback for this attempt." instead of the text. If `feedbackStatus === 'failed'`, render nothing extra (no error noise for a best-effort feature). While `feedbackStatus === 'pending'`, the page still shows the score/checks (already available) with a small "Generating feedback..." note beneath — the run itself isn't "pending" anymore, only the feedback is.

## Config

New env var in `backend/.env.example`:
- `ENCRYPTION_KEY` — 32 raw bytes, base64-encoded (e.g. generated once via `openssl rand -base64 32`), used for `LlmSettings.apiKeyEncrypted`.

No provider API keys as env vars — those live exclusively in `LlmSettings`, entered via the admin UI.

## Error Handling

No global error-handling middleware — follows the existing per-route try/catch + `{error: "message"}` JSON pattern (`backend/src/runs/routes.ts`, `backend/src/challenges/routes.ts`). A feedback-generation failure (missing config, provider error, timeout) never surfaces as an HTTP error to anyone — it's fully internal, logged server-side with the `runId`, and only visible to the end user as `feedbackStatus: 'failed'` (rendered as "no feedback available", not an error banner).

## Testing Strategy

Same pattern as the existing suite (`backend/tests/*.test.ts`, Jest + Supertest, Prisma injected via `deps`):

- `llm.settings.test.ts` — `encrypt`/`decrypt` round-trips; `saveLlmSettings` upserts the singleton row; omitting `apiKey` on an update preserves the existing encrypted value; `getLlmSettings` (admin-facing) never returns key material, only `apiKeySet`.
- `admin.routes.test.ts` — `GET`/`PUT /api/admin/llm-settings` return `401` unauthenticated, `403` for a non-admin authenticated user, `200` for an admin; validation errors (`400`) for a bad provider, a missing `baseUrl` on `ollama`, a missing `apiKey` on a first-ever `claude`/`openai`/`openrouter` save.
- `llm.providers.test.ts` — one test per provider proving the request shape (URL, headers, body) sent to the injected `fetchImpl`, and that each provider's distinct response shape is parsed into the returned string; a call that exceeds the timeout rejects.
- `runs.feedback.test.ts` — `generateFeedbackForRun` sets `feedback`/`feedbackStatus: 'ready'` on a successful provider call; sets `feedbackStatus: 'failed'` (feedback stays `null`) when no `LlmSettings` exist or the provider call throws.
- `runs.webhook.test.ts` (extended) — a `completed` callback sets `feedbackStatus: 'pending'` and triggers `generateFeedbackForRun` (mocked); an `error` callback leaves `feedbackStatus: 'not_applicable'` and never triggers generation; the webhook still responds `200` immediately without waiting on the (mocked, deliberately slow) generation call.
- `runs.routes.test.ts` (extended, `GET /api/runs/:id`) — a paid user sees `feedback` text on an old run; a free user sees `feedbackLocked: true` and no `feedback` text on anything but their globally-most-recent completed run; a free user's single most recent completed run shows the real text.

## Open Items for the Implementation Plan

- Exact prompt wording for the shared feedback template — the implementation plan should pin the literal prompt text (this design specifies its inputs — challenge title, score, per-check pass/fail/points — but not the exact wording).
- Whether `ENCRYPTION_KEY` rotation is ever needed is out of scope for v1 — a lost/rotated key means existing `LlmSettings.apiKeyEncrypted` becomes undecryptable and the admin must re-enter the key; acceptable for a single-key, 2-admin MVP.
- No retry/backoff on a failed provider call in v1 — a `failed` feedback simply stays `failed` for that run permanently (matches "best-effort" framing); a future admin-triggered "regenerate feedback" action is out of scope here.
