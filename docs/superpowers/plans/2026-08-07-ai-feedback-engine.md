# AI Feedback Engine + LLM Admin Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every completed `Run` gets one LLM-generated feedback text, written from its structured check results. An admin configures which LLM provider (Claude, OpenAI, OpenRouter, or Ollama), model, and credentials generate it — at runtime, via a new admin-only screen, not hardcoded. Free-tier users only see feedback for their single most recent completed run across all challenges; paid users see the full history.

**Architecture:** `LlmSettings` is a singleton, admin-editable Postgres row (provider/model/baseUrl/encrypted apiKey). The webhook handler marks a completed run's `feedbackStatus: 'pending'` and responds immediately, then fires `generateFeedbackForRun` without awaiting it — the LLM call itself (via `fetch`, one shared prompt template, provider-specific request/response shapes) happens after the webhook has already answered the validation engine. The frontend's existing poll-until-terminal logic on `/runs/[id]` is extended to keep polling past `completed` until `feedbackStatus` also leaves `pending`.

**Tech Stack:** Node.js 20 + TypeScript, Express, Prisma (Postgres), Jest + Supertest (backend), Next.js 14 + Vitest + Testing Library (frontend) — all existing conventions, no new HTTP client or LLM SDK dependencies (raw `fetch` for all four providers, matching how the backend already calls the validation engine). Node's built-in `crypto` for AES-256-GCM encryption of stored API keys — no new dependency there either.

## Global Constraints

- No provider API keys in environment variables — they live exclusively in `LlmSettings`, entered via the admin UI, encrypted at rest with AES-256-GCM under a new `ENCRYPTION_KEY` env var (deploy-time master key, never stored in the database, never returned by any API response) (design spec, "Encryption").
- Feedback generation is unconditional — every completed run gets an attempt regardless of `User.isPaid`; only *display* is gated by plan (`PLANO_MVP.md`, "AI Feedback Engine": "dado sempre existe e é armazenado").
- No feedback is generated for a `Run` that resolves to `status: 'error'` — `feedbackStatus` stays `'not_applicable'` for those (design spec, "Error runs get no feedback").
- "Most recent attempt" for free-tier display is the user's single most recent `completed` run **across all challenges**, not per-challenge (design spec, "Free/Paid Gating").
- The webhook must respond to the validation engine without waiting on the LLM call — `generateFeedbackForRun` is fired fire-and-forget, after the response-triggering DB update (design spec, "Architecture").
- Every provider call carries a hard timeout (30s) so `feedbackStatus` is guaranteed to leave `'pending'` — this is what bounds the frontend's extended polling, no separate frontend-side cap is needed (design spec, "Polling").
- `LlmSettings.model` is free text for every provider — no curated dropdown list is maintained; for OpenRouter and Ollama, this single field *is* how "which provider/model" is selected (design spec, "Model field").
- Code style follows the existing conventions exactly: no semicolons, single quotes, 2-space indent (both `backend/` and `frontend/`); dependencies injected into `createApp(deps)`/router-factory functions (not global singletons); tests run against a real Postgres test database via Prisma (backend), `global.fetch`/`next/navigation` mocked per test (frontend).
- Do not mark a frontend form input `required` if a test needs to submit it empty to reach a server-side validation error — jsdom enforces HTML5 constraint validation exactly like a real browser and will silently block the submit before it ever reaches your handler (already hit once in this codebase; see `frontend/app/challenges/[id]/page.tsx`'s `targetUrl` input, which deliberately has no `type="url"` for the same reason). Validate on the server; let the client stay permissive.

---

## Task 1: `LlmSettings` data model + encryption + settings service

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Modify: `backend/.env.example`
- Modify: `backend/tests/jest.setup.ts`
- Create: `backend/src/llm/settings.ts`
- Test: `backend/tests/llm.settings.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks in this plan.
- Produces: `encrypt(plaintext: string): string`, `decrypt(ciphertext: string): string`, `LlmSettingsView { provider: string | null; model: string | null; baseUrl: string | null; apiKeySet: boolean }`, `getLlmSettings(prisma): Promise<LlmSettingsView>`, `SaveLlmSettingsInput { provider: string; model: string; baseUrl?: string; apiKey?: string }`, `SaveLlmSettingsResult = { kind: 'saved' } | { kind: 'validation_error'; error: string }`, `saveLlmSettings(prisma, input): Promise<SaveLlmSettingsResult>`, `LlmProviderConfigForGeneration { provider: 'claude' | 'openai' | 'openrouter' | 'ollama'; model: string; baseUrl: string | null; apiKey: string | null }`, `LlmProviderConfigResult = { kind: 'not_configured' } | { kind: 'configured'; config: LlmProviderConfigForGeneration }`, `getLlmSettingsForGeneration(prisma): Promise<LlmProviderConfigResult>` — all from `backend/src/llm/settings.ts`. The `LlmSettings` Prisma model and `Run.feedback`/`Run.feedbackStatus` columns — used by Task 2 (admin routes call `getLlmSettings`/`saveLlmSettings`), Task 3 (`generateFeedbackForRun` calls `getLlmSettingsForGeneration`), Task 4 (webhook sets `feedbackStatus`, `getRun` reads `feedback`/`feedbackStatus`).

- [ ] **Step 1: Add the `LlmSettings` model and `Run` columns, and migrate**

Modify `backend/prisma/schema.prisma` — append after the existing `Run` model:

```prisma
model LlmSettings {
  id              String   @id                  // always the literal string "singleton"
  provider        String                         // "claude" | "openai" | "openrouter" | "ollama"
  model           String
  baseUrl         String?                        // ollama only
  apiKeyEncrypted String?                        // AES-256-GCM, "<iv>:<authTag>:<ciphertext>" (base64 each); null for ollama
  updatedAt       DateTime @updatedAt
}
```

Modify the existing `Run` model — add two fields after `callbackToken`:

```prisma
  callbackToken   String
  feedback        String?
  feedbackStatus  String   @default("not_applicable")  // not_applicable | pending | ready | failed
```

Run: `cd backend && npx prisma migrate dev --name add_llm_settings_and_run_feedback`
(Then apply to the test database: `DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npx prisma migrate deploy`.)

- [ ] **Step 2: Add the encryption env var**

Modify `backend/.env.example` — add after `RUN_TIMEOUT_MS`:

```
ENCRYPTION_KEY="replace-me-with-output-of: openssl rand -base64 32"
```

- [ ] **Step 3: Give tests a deterministic encryption key**

Modify `backend/tests/jest.setup.ts` — add at the end of the file, matching the file's existing comment style:

```ts
// ENCRYPTION_KEY: llm/settings.ts's AES-256-GCM encryption requires 32 raw bytes,
// base64-encoded. Deterministic test-only value (not a real secret) so LlmSettings
// tests can encrypt/decrypt without requiring a real deploy-time key.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || Buffer.alloc(32, 7).toString('base64')
```

- [ ] **Step 4: Write the failing test**

Create `backend/tests/llm.settings.test.ts`:

```ts
import { PrismaClient } from '@prisma/client'
import {
  encrypt,
  decrypt,
  getLlmSettings,
  saveLlmSettings,
  getLlmSettingsForGeneration,
} from '../src/llm/settings'

const prisma = new PrismaClient()

describe('encrypt/decrypt', () => {
  it('round-trips a plaintext string', () => {
    const ciphertext = encrypt('sk-test-12345')
    expect(ciphertext).not.toBe('sk-test-12345')
    expect(decrypt(ciphertext)).toBe('sk-test-12345')
  })
})

describe('saveLlmSettings / getLlmSettings / getLlmSettingsForGeneration', () => {
  afterEach(async () => {
    await prisma.llmSettings.deleteMany({})
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('returns not_configured before any save', async () => {
    const result = await getLlmSettingsForGeneration(prisma)
    expect(result).toEqual({ kind: 'not_configured' })
  })

  it('rejects an unknown provider', async () => {
    const result = await saveLlmSettings(prisma, { provider: 'bogus', model: 'x' })
    expect(result.kind).toBe('validation_error')
  })

  it('rejects a missing model', async () => {
    const result = await saveLlmSettings(prisma, { provider: 'claude', model: '', apiKey: 'sk-test' })
    expect(result.kind).toBe('validation_error')
  })

  it('rejects ollama without a baseUrl', async () => {
    const result = await saveLlmSettings(prisma, { provider: 'ollama', model: 'llama3.1' })
    expect(result.kind).toBe('validation_error')
  })

  it('rejects claude/openai/openrouter with no apiKey and none on file', async () => {
    const result = await saveLlmSettings(prisma, { provider: 'claude', model: 'claude-sonnet-5' })
    expect(result.kind).toBe('validation_error')
  })

  it('saves ollama settings with no apiKey required', async () => {
    const result = await saveLlmSettings(prisma, {
      provider: 'ollama',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
    })
    expect(result.kind).toBe('saved')

    const settings = await getLlmSettings(prisma)
    expect(settings).toEqual({
      provider: 'ollama',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
      apiKeySet: false,
    })
  })

  it('saves claude settings and never exposes the key via getLlmSettings', async () => {
    const result = await saveLlmSettings(prisma, {
      provider: 'claude',
      model: 'claude-sonnet-5',
      apiKey: 'sk-real-secret',
    })
    expect(result.kind).toBe('saved')

    const settings = await getLlmSettings(prisma)
    expect(settings).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-5',
      baseUrl: null,
      apiKeySet: true,
    })
    expect(JSON.stringify(settings)).not.toContain('sk-real-secret')
  })

  it('keeps the existing key when a later save for the same provider omits apiKey', async () => {
    await saveLlmSettings(prisma, { provider: 'claude', model: 'claude-sonnet-5', apiKey: 'sk-original' })
    const result = await saveLlmSettings(prisma, { provider: 'claude', model: 'claude-opus-5' })
    expect(result.kind).toBe('saved')

    const forGeneration = await getLlmSettingsForGeneration(prisma)
    expect(forGeneration).toEqual({
      kind: 'configured',
      config: { provider: 'claude', model: 'claude-opus-5', baseUrl: null, apiKey: 'sk-original' },
    })
  })

  it('requires a fresh apiKey when switching provider, even if a different provider key is on file', async () => {
    await saveLlmSettings(prisma, { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-openai-key' })
    const result = await saveLlmSettings(prisma, { provider: 'claude', model: 'claude-sonnet-5' })
    expect(result.kind).toBe('validation_error')
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- llm.settings.test.ts`
Expected: FAIL — `Cannot find module '../src/llm/settings'`

- [ ] **Step 6: Implement the settings service**

Create `backend/src/llm/settings.ts`:

```ts
import { PrismaClient } from '@prisma/client'
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const SETTINGS_ID = 'singleton'
const KNOWN_PROVIDERS = ['claude', 'openai', 'openrouter', 'ollama']

function encryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    throw new Error('ENCRYPTION_KEY is not set')
  }
  return Buffer.from(raw, 'base64')
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`
}

export function decrypt(encrypted: string): string {
  const [ivB64, authTagB64, ciphertextB64] = encrypted.split(':')
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ])
  return plaintext.toString('utf-8')
}

export type LlmSettingsView = {
  provider: string | null
  model: string | null
  baseUrl: string | null
  apiKeySet: boolean
}

export async function getLlmSettings(prisma: PrismaClient): Promise<LlmSettingsView> {
  const settings = await prisma.llmSettings.findUnique({ where: { id: SETTINGS_ID } })
  if (!settings) {
    return { provider: null, model: null, baseUrl: null, apiKeySet: false }
  }
  return {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    apiKeySet: settings.apiKeyEncrypted !== null,
  }
}

export type SaveLlmSettingsInput = {
  provider: string
  model: string
  baseUrl?: string
  apiKey?: string
}

export type SaveLlmSettingsResult = { kind: 'saved' } | { kind: 'validation_error'; error: string }

export async function saveLlmSettings(
  prisma: PrismaClient,
  input: SaveLlmSettingsInput
): Promise<SaveLlmSettingsResult> {
  if (!KNOWN_PROVIDERS.includes(input.provider)) {
    return { kind: 'validation_error', error: 'provider must be one of: claude, openai, openrouter, ollama' }
  }
  if (typeof input.model !== 'string' || input.model.trim().length === 0) {
    return { kind: 'validation_error', error: 'model is required' }
  }
  if (input.provider === 'ollama' && (typeof input.baseUrl !== 'string' || input.baseUrl.trim().length === 0)) {
    return { kind: 'validation_error', error: 'baseUrl is required for ollama' }
  }

  const existing = await prisma.llmSettings.findUnique({ where: { id: SETTINGS_ID } })
  // Only ever carry an encrypted key forward when the provider hasn't changed — a key
  // encrypted for one provider (e.g. an OpenAI key) is meaningless sent to another
  // (e.g. Claude), so switching providers always demands a fresh key.
  const providerUnchanged = existing?.provider === input.provider

  let apiKeyEncrypted: string | null = providerUnchanged ? existing?.apiKeyEncrypted ?? null : null
  if (input.provider === 'ollama') {
    apiKeyEncrypted = null
  } else if (input.apiKey && input.apiKey.trim().length > 0) {
    apiKeyEncrypted = encrypt(input.apiKey)
  } else if (!apiKeyEncrypted) {
    return { kind: 'validation_error', error: 'apiKey is required' }
  }

  await prisma.llmSettings.upsert({
    where: { id: SETTINGS_ID },
    update: { provider: input.provider, model: input.model, baseUrl: input.baseUrl ?? null, apiKeyEncrypted },
    create: {
      id: SETTINGS_ID,
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl ?? null,
      apiKeyEncrypted,
    },
  })

  return { kind: 'saved' }
}

export type LlmProviderConfigForGeneration = {
  provider: 'claude' | 'openai' | 'openrouter' | 'ollama'
  model: string
  baseUrl: string | null
  apiKey: string | null
}

export type LlmProviderConfigResult =
  | { kind: 'not_configured' }
  | { kind: 'configured'; config: LlmProviderConfigForGeneration }

export async function getLlmSettingsForGeneration(prisma: PrismaClient): Promise<LlmProviderConfigResult> {
  const settings = await prisma.llmSettings.findUnique({ where: { id: SETTINGS_ID } })
  if (!settings) {
    return { kind: 'not_configured' }
  }
  return {
    kind: 'configured',
    config: {
      provider: settings.provider as 'claude' | 'openai' | 'openrouter' | 'ollama',
      model: settings.model,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKeyEncrypted ? decrypt(settings.apiKeyEncrypted) : null,
    },
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- llm.settings.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 8: Commit**

```bash
git add backend/prisma backend/.env.example backend/tests/jest.setup.ts backend/src/llm/settings.ts backend/tests/llm.settings.test.ts
git commit -m "feat: add LlmSettings model, AES-256-GCM key encryption, settings service"
```

---

## Task 2: Admin access + `GET`/`PUT /api/admin/llm-settings`

**Files:**
- Create: `backend/src/admin/middleware.ts`
- Create: `backend/src/admin/routes.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/tests/admin.routes.test.ts`

**Interfaces:**
- Consumes: `getLlmSettings`, `saveLlmSettings` (Task 1, `backend/src/llm/settings.ts`), `requireAuth` (existing, `backend/src/auth/middleware.ts`).
- Produces: `requireAdmin(req, res, next)` from `backend/src/admin/middleware.ts`. `createAdminRouter(prisma: PrismaClient): Router` from `backend/src/admin/routes.ts`, mounted at root, exposing `GET`/`PUT /api/admin/llm-settings` — this is the first admin-gated route in the codebase; no other task in this plan reuses `requireAdmin` directly, but it's the precedent for future admin screens (price/ToS, out of scope here).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/admin.routes.test.ts`:

```ts
import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

// `mockAuthUser` (not `global`) because Jest's module-factory hoisting only allows
// referencing out-of-scope variables whose name starts with "mock" — this is the
// standard Jest pattern for a mock whose behavior needs to vary between tests in the
// same file (here: which user is "authenticated," to exercise both the admin and
// non-admin path against the same route without two separate test files).
let mockAuthUser = { id: 'admin-routes-test-admin', isAdmin: true }

jest.mock('passport', () => {
  const actual = jest.requireActual('passport')
  const originalAuthenticate = actual.authenticate.bind(actual)
  return Object.assign(actual, {
    authenticate: (strategy: string, ...args: any[]) => {
      if (strategy === 'session') {
        return originalAuthenticate(strategy, ...args)
      }
      return (req: any, _res: any, next: any) => {
        req.user = { id: mockAuthUser.id, username: 'octocat', avatarUrl: null, isAdmin: mockAuthUser.isAdmin }
        req.login(req.user, (err: Error) => next(err))
      }
    },
  })
})

const prisma = new PrismaClient()
const ADMIN_USER_ID = 'admin-routes-test-admin'
const NON_ADMIN_USER_ID = 'admin-routes-test-non-admin'

describe('GET/PUT /api/admin/llm-settings', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: ADMIN_USER_ID },
      update: { isAdmin: true },
      create: { id: ADMIN_USER_ID, githubId: 'gh-admin-routes-test-admin', username: 'admin-octocat', isAdmin: true },
    })
    await prisma.user.upsert({
      where: { id: NON_ADMIN_USER_ID },
      update: { isAdmin: false },
      create: { id: NON_ADMIN_USER_ID, githubId: 'gh-admin-routes-test-plain', username: 'plain-octocat', isAdmin: false },
    })
  })

  afterEach(async () => {
    await prisma.llmSettings.deleteMany({})
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: ADMIN_USER_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: NON_ADMIN_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  beforeEach(() => {
    mockAuthUser = { id: ADMIN_USER_ID, isAdmin: true }
  })

  it('GET returns 401 when not authenticated', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/admin/llm-settings')
    expect(res.status).toBe(401)
  })

  it('GET returns 403 for an authenticated non-admin', async () => {
    mockAuthUser = { id: NON_ADMIN_USER_ID, isAdmin: false }
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/admin/llm-settings')
    expect(res.status).toBe(403)
  })

  it('GET returns defaults before any save, and PUT saves and is reflected on the next GET', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const before = await agent.get('/api/admin/llm-settings')
    expect(before.status).toBe(200)
    expect(before.body).toEqual({ provider: null, model: null, baseUrl: null, apiKeySet: false })

    const put = await agent
      .put('/api/admin/llm-settings')
      .send({ provider: 'claude', model: 'claude-sonnet-5', apiKey: 'sk-test-key' })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ provider: 'claude', model: 'claude-sonnet-5', baseUrl: null, apiKeySet: true })

    const after = await agent.get('/api/admin/llm-settings')
    expect(after.status).toBe(200)
    expect(after.body).toEqual({ provider: 'claude', model: 'claude-sonnet-5', baseUrl: null, apiKeySet: true })
  })

  it('PUT returns 400 on a validation error and does not save', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.put('/api/admin/llm-settings').send({ provider: 'bogus', model: 'x' })
    expect(res.status).toBe(400)
  })

  it('PUT returns 403 for an authenticated non-admin', async () => {
    mockAuthUser = { id: NON_ADMIN_USER_ID, isAdmin: false }
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent
      .put('/api/admin/llm-settings')
      .send({ provider: 'claude', model: 'claude-sonnet-5', apiKey: 'sk-test' })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- admin.routes.test.ts`
Expected: FAIL — `GET /api/admin/llm-settings` 404s (route doesn't exist yet)

- [ ] **Step 3: Implement `requireAdmin`**

Create `backend/src/admin/middleware.ts`:

```ts
import { Request, Response, NextFunction } from 'express'

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = req.user as { isAdmin?: boolean } | undefined
  if (!user?.isAdmin) {
    res.status(403).json({ error: 'admin_required' })
    return
  }
  next()
}
```

- [ ] **Step 4: Implement the admin router**

Create `backend/src/admin/routes.ts`:

```ts
import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { requireAuth } from '../auth/middleware'
import { requireAdmin } from './middleware'
import { getLlmSettings, saveLlmSettings } from '../llm/settings'

export function createAdminRouter(prisma: PrismaClient): Router {
  const router = Router()

  router.get('/api/admin/llm-settings', requireAuth, requireAdmin, async (_req, res) => {
    const settings = await getLlmSettings(prisma)
    res.json(settings)
  })

  router.put('/api/admin/llm-settings', requireAuth, requireAdmin, async (req, res) => {
    const body = req.body ?? {}
    const result = await saveLlmSettings(prisma, {
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
    })

    if (result.kind === 'validation_error') {
      res.status(400).json({ error: result.error })
      return
    }

    const settings = await getLlmSettings(prisma)
    res.json(settings)
  })

  return router
}
```

- [ ] **Step 5: Wire the router into `createApp`**

Modify `backend/src/app.ts` — add the import alongside the existing router imports:

```ts
import { createRunsWebhookRouter } from './runs/webhook'
import { createAdminRouter } from './admin/routes'
```

And mount it alongside the existing routers (after `createRunsWebhookRouter`):

```ts
  app.use(createRunsWebhookRouter(prisma))
  app.use(createAdminRouter(prisma))
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- admin.routes.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 7: Commit**

```bash
git add backend/src/admin backend/src/app.ts backend/tests/admin.routes.test.ts
git commit -m "feat: add requireAdmin middleware and GET/PUT /api/admin/llm-settings"
```

---

## Task 3: LLM provider calls + feedback generation service

**Files:**
- Create: `backend/src/llm/providers.ts`
- Create: `backend/src/runs/feedback.ts`
- Test: `backend/tests/llm.providers.test.ts`
- Test: `backend/tests/runs.feedback.test.ts`

**Interfaces:**
- Consumes: `getLlmSettingsForGeneration` (Task 1, `backend/src/llm/settings.ts`), `LlmProviderConfigForGeneration` type (Task 1).
- Produces: `LlmProviderConfig` (same shape as `LlmProviderConfigForGeneration`), `FeedbackCheck { name: string; status: string; points: number; pointsEarned: number }`, `FeedbackPromptInput { challengeTitle: string; score: number; checks: FeedbackCheck[] }`, `generateFeedback(fetchImpl: typeof fetch, config: LlmProviderConfig, input: FeedbackPromptInput): Promise<string>` from `backend/src/llm/providers.ts`. `generateFeedbackForRun(prisma: PrismaClient, fetchImpl: typeof fetch, runId: string): Promise<void>` from `backend/src/runs/feedback.ts` — used by Task 4 (webhook fires this on a completed callback).

- [ ] **Step 1: Write the failing test for the provider calls**

Create `backend/tests/llm.providers.test.ts`:

```ts
import { generateFeedback, LlmProviderConfig, FeedbackPromptInput } from '../src/llm/providers'

const INPUT: FeedbackPromptInput = {
  challengeTitle: 'Build a Todo CRUD API',
  score: 85,
  checks: [
    { name: 'POST /todos creates a todo', status: 'passed', points: 10, pointsEarned: 10 },
    { name: 'DELETE /todos/{id} removes it', status: 'failed', points: 5, pointsEarned: 0 },
  ],
}

describe('generateFeedback', () => {
  it('calls the Claude Messages API with the right shape', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ text: 'Nice work on the create endpoint.' }] }),
    }) as any
    const config: LlmProviderConfig = { provider: 'claude', model: 'claude-sonnet-5', baseUrl: null, apiKey: 'sk-test' }

    const feedback = await generateFeedback(fetchImpl, config, INPUT)

    expect(feedback).toBe('Nice work on the create endpoint.')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(options.headers['x-api-key']).toBe('sk-test')
    expect(options.headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('claude-sonnet-5')
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].content).toContain('Build a Todo CRUD API')
    expect(body.messages[0].content).toContain('POST /todos creates a todo')
  })

  it('calls the OpenAI Chat Completions API with the right shape', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Good effort.' } }] }),
    }) as any
    const config: LlmProviderConfig = { provider: 'openai', model: 'gpt-4o', baseUrl: null, apiKey: 'sk-openai' }

    const feedback = await generateFeedback(fetchImpl, config, INPUT)

    expect(feedback).toBe('Good effort.')
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(options.headers.Authorization).toBe('Bearer sk-openai')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('gpt-4o')
  })

  it('calls the OpenRouter API with the right shape', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Solid submission.' } }] }),
    }) as any
    const config: LlmProviderConfig = {
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
      baseUrl: null,
      apiKey: 'sk-openrouter',
    }

    const feedback = await generateFeedback(fetchImpl, config, INPUT)

    expect(feedback).toBe('Solid submission.')
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(options.headers.Authorization).toBe('Bearer sk-openrouter')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('anthropic/claude-3.5-sonnet')
  })

  it('calls the Ollama local API with the right shape', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'Keep practicing.' }),
    }) as any
    const config: LlmProviderConfig = {
      provider: 'ollama',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
      apiKey: null,
    }

    const feedback = await generateFeedback(fetchImpl, config, INPUT)

    expect(feedback).toBe('Keep practicing.')
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/generate')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('llama3.1')
    expect(body.stream).toBe(false)
  })

  it('throws when a provider responds with a non-2xx status', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any
    const config: LlmProviderConfig = { provider: 'claude', model: 'claude-sonnet-5', baseUrl: null, apiKey: 'sk-test' }

    await expect(generateFeedback(fetchImpl, config, INPUT)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- llm.providers.test.ts`
Expected: FAIL — `Cannot find module '../src/llm/providers'`

- [ ] **Step 3: Implement the provider calls**

Create `backend/src/llm/providers.ts`:

```ts
export type LlmProviderConfig = {
  provider: 'claude' | 'openai' | 'openrouter' | 'ollama'
  model: string
  baseUrl: string | null
  apiKey: string | null
}

export type FeedbackCheck = {
  name: string
  status: string
  points: number
  pointsEarned: number
}

export type FeedbackPromptInput = {
  challengeTitle: string
  score: number
  checks: FeedbackCheck[]
}

const PROVIDER_TIMEOUT_MS = 30000

function buildPrompt(input: FeedbackPromptInput): string {
  const checksSummary = input.checks
    .map((check) => `- ${check.name}: ${check.status} (${check.pointsEarned}/${check.points} points)`)
    .join('\n')

  return `You are giving feedback to a developer who just completed a coding challenge called "${input.challengeTitle}".

They scored ${input.score} points. Here are the results of each check:

${checksSummary}

Write a short, encouraging paragraph (3-5 sentences) of constructive feedback. Point out what they did well and, for any failed or partially-passed checks, give a concrete hint about what likely went wrong — without giving away the exact fix. Keep it friendly and specific to their actual results, not generic.`
}

async function callWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function callClaude(fetchImpl: typeof fetch, config: LlmProviderConfig, prompt: string): Promise<string> {
  const response = await callWithTimeout(fetchImpl, 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: config.model, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!response.ok) {
    throw new Error(`claude responded ${response.status}`)
  }
  const body = await response.json()
  return body.content[0].text
}

async function callOpenaiCompatible(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string | null,
  model: string,
  prompt: string
): Promise<string> {
  const response = await callWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey ?? ''}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!response.ok) {
    throw new Error(`provider responded ${response.status}`)
  }
  const body = await response.json()
  return body.choices[0].message.content
}

async function callOllama(fetchImpl: typeof fetch, config: LlmProviderConfig, prompt: string): Promise<string> {
  const response = await callWithTimeout(fetchImpl, `${config.baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, prompt, stream: false }),
  })
  if (!response.ok) {
    throw new Error(`ollama responded ${response.status}`)
  }
  const body = await response.json()
  return body.response
}

export async function generateFeedback(
  fetchImpl: typeof fetch,
  config: LlmProviderConfig,
  input: FeedbackPromptInput
): Promise<string> {
  const prompt = buildPrompt(input)

  if (config.provider === 'claude') {
    return callClaude(fetchImpl, config, prompt)
  }
  if (config.provider === 'openai') {
    return callOpenaiCompatible(fetchImpl, 'https://api.openai.com/v1/chat/completions', config.apiKey, config.model, prompt)
  }
  if (config.provider === 'openrouter') {
    return callOpenaiCompatible(fetchImpl, 'https://openrouter.ai/api/v1/chat/completions', config.apiKey, config.model, prompt)
  }
  return callOllama(fetchImpl, config, prompt)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- llm.providers.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Write the failing test for the feedback generation service**

Create `backend/tests/runs.feedback.test.ts`:

```ts
import { PrismaClient } from '@prisma/client'
import { generateFeedbackForRun } from '../src/runs/feedback'
import { saveLlmSettings } from '../src/llm/settings'

const prisma = new PrismaClient()
const TEST_USER_ID = 'feedback-test-user'
const CHALLENGE_ID = 'feedback-test-challenge'

describe('generateFeedbackForRun', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, githubId: 'gh-feedback-test', username: 'octocat' },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_ID },
      update: {},
      create: {
        id: CHALLENGE_ID,
        title: 'Feedback Test Challenge',
        category: 'crud',
        points: 25,
        yamlPath: 'todo-api-crud.yaml',
      },
    })
  })

  afterEach(async () => {
    await prisma.run.deleteMany({ where: { userId: TEST_USER_ID } })
    await prisma.llmSettings.deleteMany({})
  })

  afterAll(async () => {
    await prisma.challenge.delete({ where: { id: CHALLENGE_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('sets feedback and feedbackStatus=ready on a successful provider call', async () => {
    await saveLlmSettings(prisma, { provider: 'claude', model: 'claude-sonnet-5', apiKey: 'sk-test' })
    const run = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 85,
        checks: [{ name: 'check', status: 'passed', points: 10, pointsEarned: 10 }],
        feedbackStatus: 'pending',
        callbackToken: 'unused',
      },
    })
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ text: 'Great job!' }] }),
    }) as any

    await generateFeedbackForRun(prisma, fetchImpl, run.id)

    const updated = await prisma.run.findUnique({ where: { id: run.id } })
    expect(updated?.feedbackStatus).toBe('ready')
    expect(updated?.feedback).toBe('Great job!')
  })

  it('sets feedbackStatus=failed when no LlmSettings are configured', async () => {
    const run = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 50,
        checks: [],
        feedbackStatus: 'pending',
        callbackToken: 'unused',
      },
    })
    const fetchImpl = jest.fn() as any

    await generateFeedbackForRun(prisma, fetchImpl, run.id)

    const updated = await prisma.run.findUnique({ where: { id: run.id } })
    expect(updated?.feedbackStatus).toBe('failed')
    expect(updated?.feedback).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sets feedbackStatus=failed when the provider call throws', async () => {
    await saveLlmSettings(prisma, { provider: 'claude', model: 'claude-sonnet-5', apiKey: 'sk-test' })
    const run = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 20,
        checks: [],
        feedbackStatus: 'pending',
        callbackToken: 'unused',
      },
    })
    const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as any

    await generateFeedbackForRun(prisma, fetchImpl, run.id)

    const updated = await prisma.run.findUnique({ where: { id: run.id } })
    expect(updated?.feedbackStatus).toBe('failed')
    expect(updated?.feedback).toBeNull()
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- runs.feedback.test.ts`
Expected: FAIL — `Cannot find module '../src/runs/feedback'`

- [ ] **Step 7: Implement the feedback generation service**

Create `backend/src/runs/feedback.ts`:

```ts
import { PrismaClient } from '@prisma/client'
import { getLlmSettingsForGeneration } from '../llm/settings'
import { generateFeedback, FeedbackCheck } from '../llm/providers'

export async function generateFeedbackForRun(
  prisma: PrismaClient,
  fetchImpl: typeof fetch,
  runId: string
): Promise<void> {
  try {
    const run = await prisma.run.findUnique({ where: { id: runId }, include: { challenge: true } })
    if (!run) {
      return
    }

    const settingsResult = await getLlmSettingsForGeneration(prisma)
    if (settingsResult.kind === 'not_configured') {
      await prisma.run.update({ where: { id: runId }, data: { feedbackStatus: 'failed' } })
      return
    }

    const checks: FeedbackCheck[] = Array.isArray(run.checks) ? (run.checks as unknown as FeedbackCheck[]) : []

    const feedback = await generateFeedback(fetchImpl, settingsResult.config, {
      challengeTitle: run.challenge.title,
      score: run.score ?? 0,
      checks,
    })

    await prisma.run.update({ where: { id: runId }, data: { feedback, feedbackStatus: 'ready' } })
  } catch (err) {
    console.error(`Feedback generation failed for run ${runId}:`, err)
    await prisma.run.update({ where: { id: runId }, data: { feedbackStatus: 'failed' } }).catch(() => {})
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- runs.feedback.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Commit**

```bash
git add backend/src/llm/providers.ts backend/src/runs/feedback.ts backend/tests/llm.providers.test.ts backend/tests/runs.feedback.test.ts
git commit -m "feat: call Claude/OpenAI/OpenRouter/Ollama for run feedback"
```

---

## Task 4: Wire feedback into the webhook + gate it on `GET /api/runs/:id`

**Files:**
- Modify: `backend/src/runs/webhook.ts`
- Modify: `backend/src/runs/service.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/tests/runs.webhook.test.ts`
- Test: `backend/tests/runs.routes.test.ts`

**Interfaces:**
- Consumes: `generateFeedbackForRun` (Task 3, `backend/src/runs/feedback.ts`).
- Produces: `GetRunResult`'s `run` object gains `feedback: string | null`, `feedbackStatus: string`, `feedbackLocked: boolean` — used by Task 6 (frontend `/runs/[id]` reads these fields).

- [ ] **Step 1: Write the failing tests for the webhook**

Modify `backend/tests/runs.webhook.test.ts` — append two new `it` blocks inside the existing `describe('POST /api/webhooks/runs/:jobId', ...)`, just before its closing `})`:

```ts
  it('marks feedbackStatus pending on a completed callback and responds before feedback generation finishes', async () => {
    await prisma.llmSettings.upsert({
      where: { id: 'singleton' },
      update: { provider: 'ollama', model: 'llama3.1', baseUrl: 'http://ollama.test', apiKeyEncrypted: null },
      create: {
        id: 'singleton',
        provider: 'ollama',
        model: 'llama3.1',
        baseUrl: 'http://ollama.test',
        apiKeyEncrypted: null,
      },
    })
    await createPendingRun('webhook-test-run-6', 'correct-token')

    let resolveFeedbackCall: (value: { ok: boolean; json: () => Promise<unknown> }) => void = () => {}
    const slowFeedbackCall = new Promise((resolve) => {
      resolveFeedbackCall = resolve as typeof resolveFeedbackCall
    })
    const fetchImpl = jest.fn().mockImplementation(() => slowFeedbackCall)
    const app = createApp({ prisma, fetchImpl })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-6?token=correct-token')
      .send({ status: 'completed', score: 90, checks: [] })

    expect(res.status).toBe(200)

    const run = await prisma.run.findUnique({ where: { id: 'webhook-test-run-6' } })
    expect(run?.status).toBe('completed')
    expect(run?.feedbackStatus).toBe('pending')

    resolveFeedbackCall({ ok: true, json: async () => ({ response: 'Nice work.' }) })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const resolved = await prisma.run.findUnique({ where: { id: 'webhook-test-run-6' } })
    expect(resolved?.feedbackStatus).toBe('ready')
    expect(resolved?.feedback).toBe('Nice work.')

    await prisma.llmSettings.deleteMany({})
  })

  it('leaves feedbackStatus not_applicable and never calls the LLM on an error callback', async () => {
    await createPendingRun('webhook-test-run-7', 'correct-token')
    const fetchImpl = jest.fn()
    const app = createApp({ prisma, fetchImpl })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-7?token=correct-token')
      .send({ status: 'error', error: 'boom' })

    expect(res.status).toBe(200)
    const run = await prisma.run.findUnique({ where: { id: 'webhook-test-run-7' } })
    expect(run?.feedbackStatus).toBe('not_applicable')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Write the failing tests for `GET /api/runs/:id`**

Modify `backend/tests/runs.routes.test.ts` — append two new `it` blocks inside the existing `describe('GET /api/runs/:id', ...)`, just before its closing `})` (reuses the `TEST_USER_ID`, `CHALLENGE_ID`, `prisma`, `createApp` already in scope in this file):

```ts
  it('shows feedback text to a paid user on an older run', async () => {
    await prisma.user.update({ where: { id: TEST_USER_ID }, data: { isPaid: true } })
    const olderRun = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 70,
        feedback: 'Older feedback text',
        feedbackStatus: 'ready',
        callbackToken: 'unused',
        createdAt: new Date(Date.now() - 60000),
      },
    })
    await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 90,
        feedback: 'Newer feedback text',
        feedbackStatus: 'ready',
        callbackToken: 'unused',
      },
    })

    const app = createApp({ prisma, fetchImpl: jest.fn() as any })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get(`/api/runs/${olderRun.id}`)
    expect(res.status).toBe(200)
    expect(res.body.feedback).toBe('Older feedback text')
    expect(res.body.feedbackLocked).toBe(false)

    await prisma.user.update({ where: { id: TEST_USER_ID }, data: { isPaid: false } })
  })

  it('locks feedback for a free user on anything but their most recent completed run', async () => {
    const olderRun = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 70,
        feedback: 'Older feedback text',
        feedbackStatus: 'ready',
        callbackToken: 'unused',
        createdAt: new Date(Date.now() - 60000),
      },
    })
    const newerRun = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 90,
        feedback: 'Newer feedback text',
        feedbackStatus: 'ready',
        callbackToken: 'unused',
      },
    })

    const app = createApp({ prisma, fetchImpl: jest.fn() as any })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const olderRes = await agent.get(`/api/runs/${olderRun.id}`)
    expect(olderRes.status).toBe(200)
    expect(olderRes.body.feedbackLocked).toBe(true)
    expect(olderRes.body.feedback).toBeNull()

    const newerRes = await agent.get(`/api/runs/${newerRun.id}`)
    expect(newerRes.status).toBe(200)
    expect(newerRes.body.feedbackLocked).toBe(false)
    expect(newerRes.body.feedback).toBe('Newer feedback text')
  })
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- runs.webhook.test.ts runs.routes.test.ts`
Expected: FAIL — the new webhook tests fail because `feedbackStatus` is never set; the new routes tests fail because the response has no `feedback`/`feedbackLocked` fields

- [ ] **Step 4: Wire feedback generation into the webhook**

Replace the full contents of `backend/src/runs/webhook.ts`:

```ts
import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { timingSafeEqual } from 'crypto'
import { generateFeedbackForRun } from './feedback'

function tokensMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected)
  const providedBuf = Buffer.from(provided)
  if (expectedBuf.length !== providedBuf.length) {
    return false
  }
  return timingSafeEqual(expectedBuf, providedBuf)
}

export function createRunsWebhookRouter(prisma: PrismaClient, fetchImpl: typeof fetch): Router {
  const router = Router()

  router.post('/api/webhooks/runs/:jobId', async (req, res) => {
    const run = await prisma.run.findUnique({ where: { id: req.params.jobId } })
    if (!run) {
      res.status(404).json({ error: 'run_not_found' })
      return
    }

    const token = typeof req.query.token === 'string' ? req.query.token : ''
    if (!tokensMatch(run.callbackToken, token)) {
      res.status(403).json({ error: 'invalid_token' })
      return
    }

    if (run.status !== 'pending') {
      res.status(200).json({ status: 'already_processed' })
      return
    }

    const body = req.body ?? {}
    if (body.status !== 'completed' && body.status !== 'error') {
      res.status(400).json({ error: 'invalid_status' })
      return
    }

    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: body.status,
        score: body.score ?? null,
        error: body.error ?? null,
        // The engine's RunResult omits `checks` entirely on an error status (rather than
        // sending it as JSON null) — only spread it in when present, so we never pass a bare
        // `null` for this Json? column (Prisma treats that ambiguously; explicit omission
        // avoids the question entirely).
        ...(body.checks !== undefined ? { checks: body.checks } : {}),
        ...(body.status === 'completed' ? { feedbackStatus: 'pending' } : {}),
      },
    })

    if (body.status === 'completed') {
      // Fire-and-forget: the webhook must respond to the validation engine immediately,
      // not wait on an LLM call that can take seconds. generateFeedbackForRun always
      // resolves the Run to feedbackStatus 'ready' or 'failed' internally, never throws.
      generateFeedbackForRun(prisma, fetchImpl, run.id).catch((err) => {
        console.error(`Feedback generation failed for run ${run.id}:`, err)
      })
    }

    res.status(200).json({ status: 'ok' })
  })

  return router
}
```

- [ ] **Step 5: Gate feedback in `getRun`**

Modify `backend/src/runs/service.ts` — update the `GetRunResult` type's `run` object (add three fields after `createdAt: Date`):

```ts
export type GetRunResult =
  | { kind: 'not_found' }
  | {
      kind: 'found'
      run: {
        runId: string
        challengeId: string
        targetUrl: string
        status: string
        score: number | null
        checks: unknown
        error: string | null
        createdAt: Date
        feedback: string | null
        feedbackStatus: string
        feedbackLocked: boolean
      }
    }
```

Add this function above `getRun`:

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

Replace the body of `getRun`:

```ts
export async function getRun(
  prisma: PrismaClient,
  runTimeoutMs: number,
  input: GetRunInput
): Promise<GetRunResult> {
  const run = await prisma.run.findUnique({ where: { id: input.runId } })
  if (!run || run.userId !== input.userId) {
    return { kind: 'not_found' }
  }

  const isStale = run.status === 'pending' && Date.now() - run.createdAt.getTime() > runTimeoutMs
  const status = isStale ? 'timed_out' : run.status

  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId } })
  let feedbackLocked = false
  if (!user.isPaid && run.status === 'completed') {
    const isMostRecent = await isMostRecentCompletedRun(prisma, input.userId, run.id)
    feedbackLocked = !isMostRecent
  }

  return {
    kind: 'found',
    run: {
      runId: run.id,
      challengeId: run.challengeId,
      targetUrl: run.targetUrl,
      status,
      score: run.score,
      checks: run.checks,
      error: run.error,
      createdAt: run.createdAt,
      feedback: feedbackLocked ? null : run.feedback,
      feedbackStatus: run.feedbackStatus,
      feedbackLocked,
    },
  }
}
```

- [ ] **Step 6: Thread `fetchImpl` into the webhook router in `createApp`**

Modify `backend/src/app.ts` — change the webhook router mount line:

```ts
  app.use(createRunsWebhookRouter(prisma, fetchImpl))
```

- [ ] **Step 7: Run both test files to verify they pass**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- runs.webhook.test.ts runs.routes.test.ts`
Expected: PASS (8 tests in `runs.webhook.test.ts`, 12 tests in `runs.routes.test.ts`)

- [ ] **Step 8: Run the full backend suite**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test`
Expected: PASS (all suites)

- [ ] **Step 9: Commit**

```bash
git add backend/src/runs backend/src/app.ts backend/tests/runs.webhook.test.ts backend/tests/runs.routes.test.ts
git commit -m "feat: fire feedback generation from the webhook, gate it in GET /api/runs/:id"
```

---

## Task 5: Admin LLM settings page (`/admin/llm-settings`)

**Files:**
- Create: `frontend/app/admin/llm-settings/page.tsx`
- Test: `frontend/tests/admin-llm-settings.test.tsx`

**Interfaces:**
- Consumes: `useResource`, `backendFetch` (`frontend/app/lib/api.ts`, already implemented).
- Produces: nothing new for other tasks — this page is reached by direct navigation (no link from `/dashboard` is added in this plan; out of scope per the design's frontend section, which only specifies this page and `/runs/[id]`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/admin-llm-settings.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminLlmSettingsPage from '../app/admin/llm-settings/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}))

const ADMIN_ME = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: true }
const NON_ADMIN_ME = { id: '2', username: 'someone', avatarUrl: null, isAdmin: false }
const SETTINGS = { provider: 'claude', model: 'claude-sonnet-5', baseUrl: null, apiKeySet: true }

function mockFetch(routes: {
  me?: { status: number; json?: unknown }
  get?: { status: number; json?: unknown }
  put?: { status: number; json?: unknown }
}) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const isMe = url.includes('/api/me')
    const isPut = init?.method === 'PUT'
    const route = isMe ? routes.me : isPut ? routes.put : routes.get
    const status = route?.status ?? 500
    return Promise.resolve({ status, json: async () => route?.json })
  }) as any
}

describe('AdminLlmSettingsPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
  })

  it('shows "Not authorized." for a non-admin user', async () => {
    mockFetch({ me: { status: 200, json: NON_ADMIN_ME }, get: { status: 200, json: SETTINGS } })

    render(<AdminLlmSettingsPage />)

    await waitFor(() => {
      expect(screen.getByText('Not authorized.')).toBeInTheDocument()
    })
  })

  it('renders the form pre-filled with existing settings for an admin', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: SETTINGS } })

    render(<AdminLlmSettingsPage />)

    await waitFor(() => {
      expect(screen.getByDisplayValue('claude-sonnet-5')).toBeInTheDocument()
    })
    expect(screen.getByText(/leave blank to keep current key/i)).toBeInTheDocument()
  })

  it('shows the base URL field only when provider is ollama', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: SETTINGS } })
    const user = userEvent.setup()

    render(<AdminLlmSettingsPage />)
    await waitFor(() => screen.getByDisplayValue('claude-sonnet-5'))

    expect(screen.queryByLabelText(/base url/i)).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText(/provider/i), 'ollama')

    expect(screen.getByLabelText(/base url/i)).toBeInTheDocument()
  })

  it('saves successfully and shows a confirmation', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: SETTINGS },
      put: { status: 200, json: { ...SETTINGS, model: 'claude-opus-5' } },
    })
    const user = userEvent.setup()

    render(<AdminLlmSettingsPage />)
    await waitFor(() => screen.getByDisplayValue('claude-sonnet-5'))

    await user.clear(screen.getByLabelText(/model/i))
    await user.type(screen.getByLabelText(/model/i), 'claude-opus-5')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(screen.getByText('Settings saved.')).toBeInTheDocument()
    })
  })

  it('shows the server error message on a validation failure', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: SETTINGS },
      put: { status: 400, json: { error: 'model is required' } },
    })
    const user = userEvent.setup()

    render(<AdminLlmSettingsPage />)
    await waitFor(() => screen.getByDisplayValue('claude-sonnet-5'))

    await user.clear(screen.getByLabelText(/model/i))
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(screen.getByText('model is required')).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- admin-llm-settings.test.tsx`
Expected: FAIL — `Cannot find module '../app/admin/llm-settings/page'`

- [ ] **Step 3: Implement the admin settings page**

Create `frontend/app/admin/llm-settings/page.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useResource, backendFetch } from '../../lib/api'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
}

type LlmSettings = {
  provider: string | null
  model: string | null
  baseUrl: string | null
  apiKeySet: boolean
}

export default function AdminLlmSettingsPage() {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const settings = useResource<LlmSettings>('/api/admin/llm-settings')

  const [provider, setProvider] = useState('claude')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (settings.data) {
      setProvider(settings.data.provider ?? 'claude')
      setModel(settings.data.model ?? '')
      setBaseUrl(settings.data.baseUrl ?? '')
    }
  }, [settings.data])

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaveError(null)
    setSaved(false)
    setSaving(true)

    backendFetch('/api/admin/llm-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        model,
        baseUrl: provider === 'ollama' ? baseUrl : undefined,
        apiKey: apiKey.trim().length > 0 ? apiKey : undefined,
      }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 200) {
          setSaved(true)
          setApiKey('')
          setSaving(false)
          return
        }
        setSaveError(body.error ?? 'Could not save settings.')
        setSaving(false)
      })
      .catch(() => {
        setSaveError('Could not save settings.')
        setSaving(false)
      })
  }

  if (me.loading || settings.loading) return <p>Loading...</p>
  if (me.error) return <p>Something went wrong loading this page.</p>
  if (!me.data) return null
  if (!me.data.isAdmin) return <p>Not authorized.</p>
  if (settings.error) return <p>Could not load LLM settings.</p>
  if (!settings.data) return null

  return (
    <main>
      <h1>LLM Settings</h1>
      <form onSubmit={handleSubmit}>
        <label>
          Provider
          <select value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="claude">Claude</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="ollama">Ollama</option>
          </select>
        </label>
        <label>
          Model
          <input value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
        {provider === 'ollama' && (
          <label>
            Base URL
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
        )}
        {provider !== 'ollama' && (
          <label>
            API Key {settings.data.apiKeySet ? '(leave blank to keep current key)' : ''}
            <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </label>
        )}
        <button type="submit" disabled={saving}>
          Save
        </button>
      </form>
      {saveError && <p>{saveError}</p>}
      {saved && <p>Settings saved.</p>}
    </main>
  )
}
```

Note: `model` and `baseUrl` inputs deliberately have no `required` attribute — validation happens server-side (see Global Constraints), so a test can submit an empty `model` and observe the server's `400` instead of the browser silently blocking the submit.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npm test -- admin-llm-settings.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/admin frontend/tests/admin-llm-settings.test.tsx
git commit -m "feat: add admin LLM settings page"
```

---

## Task 6: Show feedback on `/runs/[id]`, extend polling, document `ENCRYPTION_KEY`

**Files:**
- Modify: `frontend/app/runs/[id]/page.tsx`
- Modify: `frontend/tests/runs-status.test.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: `feedback`/`feedbackStatus`/`feedbackLocked` fields on `GET /api/runs/:id`'s response (Task 4).
- Produces: nothing new for other tasks — this is the plan's final piece, the frontend surface of everything built in Tasks 1-4.

- [ ] **Step 1: Write the failing tests**

Modify `frontend/tests/runs-status.test.tsx` — append three new `it` blocks inside the existing `describe('RunStatusPage', ...)`, just before its closing `})` (reuses `jsonResponse`, `replaceMock` already declared in this file):

```tsx
  it('keeps polling past completed while feedback is still generating, then shows it once ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse(200, {
          runId: 'run-5',
          status: 'completed',
          score: 100,
          checks: [],
          error: null,
          feedback: null,
          feedbackStatus: 'pending',
          feedbackLocked: false,
        })
      )
      .mockImplementationOnce(() =>
        jsonResponse(200, {
          runId: 'run-5',
          status: 'completed',
          score: 100,
          checks: [],
          error: null,
          feedback: 'Great work on this one!',
          feedbackStatus: 'ready',
          feedbackLocked: false,
        })
      )
    global.fetch = fetchMock as any

    render(<RunStatusPage params={{ id: 'run-5' }} />)

    await waitFor(() => expect(screen.getByText(/generating feedback/i)).toBeInTheDocument())
    expect(screen.getByText('Score: 100')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    await waitFor(() => expect(screen.getByText('Great work on this one!')).toBeInTheDocument())

    const callsAfterReady = fetchMock.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(fetchMock.mock.calls.length).toBe(callsAfterReady)
  })

  it('shows an upgrade message instead of feedback text when locked', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        await jsonResponse(200, {
          runId: 'run-6',
          status: 'completed',
          score: 60,
          checks: [],
          error: null,
          feedback: null,
          feedbackStatus: 'ready',
          feedbackLocked: true,
        })
      ) as any

    render(<RunStatusPage params={{ id: 'run-6' }} />)

    await waitFor(() => {
      expect(screen.getByText('Upgrade to see feedback for this attempt.')).toBeInTheDocument()
    })
  })

  it('shows nothing extra when feedback generation failed', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        await jsonResponse(200, {
          runId: 'run-7',
          status: 'completed',
          score: 40,
          checks: [],
          error: null,
          feedback: null,
          feedbackStatus: 'failed',
          feedbackLocked: false,
        })
      ) as any

    render(<RunStatusPage params={{ id: 'run-7' }} />)

    await waitFor(() => expect(screen.getByText('Score: 40')).toBeInTheDocument())
    expect(screen.queryByText(/generating feedback/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/upgrade to see feedback/i)).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- runs-status.test.tsx`
Expected: FAIL — the new tests fail because the page has no feedback-aware rendering or polling-stop logic yet; the 7 pre-existing tests still pass (their mock payloads have no `feedbackStatus`, and `undefined !== 'pending'` already stops polling the same way `'ready'`/`'failed'` would)

- [ ] **Step 3: Implement the feedback display and extended polling**

Replace the full contents of `frontend/app/runs/[id]/page.tsx`:

```tsx
'use client'

import { useResource } from '../../lib/api'

type Check = {
  name: string
  status: string
  points: number
  pointsEarned: number
}

type RunStatus = {
  runId: string
  challengeId: string
  targetUrl: string
  status: string
  score: number | null
  checks: Check[] | null
  error: string | null
  createdAt: string
  feedback: string | null
  feedbackStatus: string
  feedbackLocked: boolean
}

function isTerminal(run: RunStatus): boolean {
  if (run.status === 'pending') return false
  if (run.status === 'completed') return run.feedbackStatus !== 'pending'
  return true
}

export default function RunStatusPage({ params }: { params: { id: string } }) {
  const run = useResource<RunStatus>(`/api/runs/${params.id}`, {
    redirectOn401: true,
    pollMs: 2000,
    stopPolling: isTerminal,
  })

  if (run.loading) return <p>Loading...</p>
  if (run.notFound) return <p>Run not found.</p>
  if (run.error) return <p>Something went wrong loading this run.</p>
  if (!run.data) return null

  if (run.data.status === 'pending') {
    return <p>Running your submission...</p>
  }

  if (run.data.status === 'completed') {
    return (
      <main>
        <h1>Score: {run.data.score}</h1>
        <ul>
          {(run.data.checks ?? []).map((check) => (
            <li key={check.name}>
              {check.name}: {check.status} ({check.pointsEarned}/{check.points})
            </li>
          ))}
        </ul>
        {run.data.feedbackStatus === 'pending' && <p>Generating feedback...</p>}
        {run.data.feedbackLocked && <p>Upgrade to see feedback for this attempt.</p>}
        {run.data.feedbackStatus === 'ready' && !run.data.feedbackLocked && <p>{run.data.feedback}</p>}
      </main>
    )
  }

  if (run.data.status === 'timed_out') {
    return <p>This is taking longer than expected — check back later.</p>
  }

  return <p>{run.data.error}</p>
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npm test -- runs-status.test.tsx`
Expected: PASS (10 tests)

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test`
Expected: PASS (all suites)

- [ ] **Step 6: Document `ENCRYPTION_KEY` and the admin LLM settings page**

Modify `README.md` — add a new section after "## Challenges & the validation engine":

```markdown
## AI feedback

Every completed run gets one LLM-generated feedback text, produced by whichever provider an
admin has configured at `/admin/llm-settings` (Claude, OpenAI, OpenRouter, or Ollama) — see
`docs/superpowers/specs/2026-08-07-ai-feedback-engine-design.md` for the full design.

1. Generate a real encryption key for stored provider API keys and set it in `backend/.env`:
   `openssl rand -base64 32`, assigned to `ENCRYPTION_KEY`.
2. Log in with an account listed in `ADMIN_GITHUB_USERNAMES`, then visit `/admin/llm-settings`
   to pick a provider, model, and (for Claude/OpenAI/OpenRouter) an API key — or a base URL
   instead, for a locally-running Ollama.
3. Until a provider is configured, completed runs still work normally — their feedback simply
   resolves to unavailable (`feedbackStatus: "failed"`), never blocking the run itself.
```

- [ ] **Step 7: Commit**

```bash
git add frontend/app/runs frontend/tests/runs-status.test.tsx README.md
git commit -m "feat: show run feedback with free-tier lock, extend polling past completed"
```
