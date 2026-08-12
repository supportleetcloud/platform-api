# Ollama Model Listing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the admin LLM settings page's provider is set to Ollama, list the models actually installed on the configured Ollama server in a dropdown instead of a free-text input.

**Architecture:** The backend proxies Ollama's `GET {baseUrl}/api/tags` (the browser can't call it directly — Ollama doesn't set CORS headers for arbitrary origins). A new admin-gated route, `GET /api/admin/llm-settings/ollama-models`, fetches and returns the model list; the frontend calls it automatically (no button) when the provider becomes `ollama` with a base URL present, and renders a `<select>` on success or falls back to the existing free-text `<input>` on any failure.

**Tech Stack:** Express + Prisma (backend), Next.js + plain `useState` (frontend) — same stack as the rest of the admin surface, no new dependencies.

## Global Constraints

- Backend proxies Ollama's `/api/tags` — the browser never calls the Ollama server directly.
- New route: `GET /api/admin/llm-settings/ollama-models`, query param `baseUrl`, gated by the same `requireAuth, requireAdmin` middleware chain as every sibling admin route.
- Timeout on the proxy call: 5 seconds (`OLLAMA_MODELS_TIMEOUT_MS`) — this is a synchronous admin-UI request, not a background job, so it must fail fast.
- Route responses: missing/empty `baseUrl` → `400 { error: 'baseUrl is required' }`; the Ollama call throwing (network error, timeout, non-OK response) → `502 { error: 'could not reach ollama' }`; success → `200 { models: string[] }`. An empty array is a valid `200`, not an error, at the route level.
- Fetch trigger on the frontend is automatic, no button: (a) provider is (or becomes) `ollama` with a non-empty base URL already present — including on initial page load when the saved settings are already Ollama — and (b) the Base URL field is blurred while provider is `ollama`.
- Model field UI: renders a `<select>` populated with the fetched models when the fetch succeeded with a non-empty list; falls back to the existing free-text `<input>` on any fetch failure or an empty list, showing `Could not load Ollama models.` below the field. Switching the provider away from `ollama` always reverts to the input and clears all model-list state.
- Code style matches the existing codebase exactly: no semicolons, single quotes, 2-space indent; dependencies injected via factory functions (`createXRouter(prisma, ...)`); backend tests use `supertest` against a real Postgres test database via Prisma for anything DB-backed; frontend tests mock `global.fetch` and `next/navigation`.

---

## Task 1: `llm/ollama.ts` — fetch and parse the Ollama model list

**Files:**
- Create: `backend/src/llm/ollama.ts`
- Test: `backend/tests/llm.ollama.test.ts`

**Interfaces:**
- Consumes: nothing new (only the injected `fetchImpl: typeof fetch`, same convention as `backend/src/llm/providers.ts`'s `generateFeedback`).
- Produces: `listOllamaModels(fetchImpl: typeof fetch, baseUrl: string): Promise<string[]>` — Task 2's route handler calls this directly.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/llm.ollama.test.ts`:

```ts
import { listOllamaModels } from '../src/llm/ollama'

describe('listOllamaModels', () => {
  it('returns the model names from a successful /api/tags response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: 'llama3:latest' }, { name: 'mistral:latest' }],
      }),
    }) as any

    const models = await listOllamaModels(fetchImpl, 'http://localhost:11434')

    expect(models).toEqual(['llama3:latest', 'mistral:latest'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/tags')
  })

  it('returns an empty array when the response has no models field', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as any

    const models = await listOllamaModels(fetchImpl, 'http://localhost:11434')

    expect(models).toEqual([])
  })

  it('throws when the response is not ok', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as any

    await expect(listOllamaModels(fetchImpl, 'http://localhost:11434')).rejects.toThrow()
  })

  it('throws when the fetch itself fails (e.g. connection refused)', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as any

    await expect(listOllamaModels(fetchImpl, 'http://localhost:11434')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest tests/llm.ollama.test.ts`
Expected: FAIL — `Cannot find module '../src/llm/ollama'` (the file doesn't exist yet).

- [ ] **Step 3: Write `llm/ollama.ts`**

Create `backend/src/llm/ollama.ts`:

```ts
const OLLAMA_MODELS_TIMEOUT_MS = 5000

export async function listOllamaModels(fetchImpl: typeof fetch, baseUrl: string): Promise<string[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OLLAMA_MODELS_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}/api/tags`, { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    throw new Error(`ollama responded ${response.status}`)
  }

  const body = await response.json()
  const models = Array.isArray(body.models) ? body.models : []
  return models.map((model: { name: string }) => model.name)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest tests/llm.ollama.test.ts`
Expected: PASS, all 4 cases green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/ollama.ts backend/tests/llm.ollama.test.ts
git commit -m "feat: add listOllamaModels to fetch and parse Ollama's /api/tags"
```

---

## Task 2: `GET /api/admin/llm-settings/ollama-models` route

**Files:**
- Modify: `backend/src/admin/routes.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/tests/admin.routes.test.ts` (extended)

**Interfaces:**
- Consumes: `listOllamaModels(fetchImpl, baseUrl): Promise<string[]>` (Task 1, `backend/src/llm/ollama.ts`); `createApp(deps: { prisma?, fetchImpl?, stripeClient? })`'s existing `fetchImpl` injection point (`backend/src/app.ts`, already used by `createRunsRouter`/`createRunsWebhookRouter`).
- Produces: route `GET /api/admin/llm-settings/ollama-models?baseUrl=<url>` — Task 3's frontend page calls this. `createAdminRouter`'s signature changes from `(prisma, stripe)` to `(prisma, stripe, fetchImpl)`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `backend/tests/admin.routes.test.ts`, right after the closing `})` of the existing `describe('GET/PUT /api/admin/llm-settings', ...)` block (i.e. before `describe('GET/POST /api/admin/tos/versions', ...)`):

```ts
describe('GET /api/admin/llm-settings/ollama-models', () => {
  const OLLAMA_ADMIN_USER_ID = 'admin-routes-ollama-test-admin'
  const OLLAMA_NON_ADMIN_USER_ID = 'admin-routes-ollama-test-non-admin'

  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: OLLAMA_ADMIN_USER_ID },
      update: { isAdmin: true },
      create: { id: OLLAMA_ADMIN_USER_ID, githubId: 'gh-admin-routes-ollama-admin', username: 'admin-octocat', isAdmin: true },
    })
    await prisma.user.upsert({
      where: { id: OLLAMA_NON_ADMIN_USER_ID },
      update: { isAdmin: false },
      create: { id: OLLAMA_NON_ADMIN_USER_ID, githubId: 'gh-admin-routes-ollama-plain', username: 'plain-octocat', isAdmin: false },
    })
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: OLLAMA_ADMIN_USER_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: OLLAMA_NON_ADMIN_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  beforeEach(() => {
    mockAuthUser = { id: OLLAMA_ADMIN_USER_ID, isAdmin: true }
  })

  it('returns 401 when not authenticated', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/admin/llm-settings/ollama-models?baseUrl=http://localhost:11434')
    expect(res.status).toBe(401)
  })

  it('returns 403 for an authenticated non-admin', async () => {
    mockAuthUser = { id: OLLAMA_NON_ADMIN_USER_ID, isAdmin: false }
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/admin/llm-settings/ollama-models?baseUrl=http://localhost:11434')
    expect(res.status).toBe(403)
  })

  it('returns 400 when baseUrl is missing', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/admin/llm-settings/ollama-models')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'baseUrl is required' })
  })

  it('returns the model list on success', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3:latest' }] }),
    }) as any
    const app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/admin/llm-settings/ollama-models?baseUrl=http://localhost:11434')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ models: ['llama3:latest'] })
    const [url] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/tags')
  })

  it('returns 502 when ollama is unreachable', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as any
    const app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/admin/llm-settings/ollama-models?baseUrl=http://localhost:11434')
    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: 'could not reach ollama' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest tests/admin.routes.test.ts -t "ollama-models"`
Expected: FAIL — the route doesn't exist yet, so every request falls through to the app's 404 handler instead of the expected status codes.

- [ ] **Step 3: Add the route**

In `backend/src/admin/routes.ts`, change the import line:

```ts
import { getLlmSettings, saveLlmSettings } from '../llm/settings'
```

to:

```ts
import { getLlmSettings, saveLlmSettings } from '../llm/settings'
import { listOllamaModels } from '../llm/ollama'
```

Change the function signature:

```ts
export function createAdminRouter(prisma: PrismaClient, stripe: Stripe): Router {
```

to:

```ts
export function createAdminRouter(prisma: PrismaClient, stripe: Stripe, fetchImpl: typeof fetch): Router {
```

Add the new route immediately after the closing `})` of the existing `router.put('/api/admin/llm-settings', ...)` block (i.e. right before `router.get('/api/admin/tos/versions', ...)`):

```ts
  router.get('/api/admin/llm-settings/ollama-models', requireAuth, requireAdmin, async (req, res) => {
    const baseUrl = typeof req.query.baseUrl === 'string' ? req.query.baseUrl.trim() : ''
    if (baseUrl.length === 0) {
      res.status(400).json({ error: 'baseUrl is required' })
      return
    }

    try {
      const models = await listOllamaModels(fetchImpl, baseUrl)
      res.json({ models })
    } catch (err) {
      res.status(502).json({ error: 'could not reach ollama' })
    }
  })
```

In `backend/src/app.ts`, change:

```ts
  app.use(createAdminRouter(prisma, stripe))
```

to:

```ts
  app.use(createAdminRouter(prisma, stripe, fetchImpl))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest tests/admin.routes.test.ts`
Expected: PASS, every case in the file green (including the pre-existing `llm-settings`/`tos`/`billing-settings` blocks — confirms the signature change didn't break the other call site).

- [ ] **Step 5: Commit**

```bash
git add backend/src/admin/routes.ts backend/src/app.ts backend/tests/admin.routes.test.ts
git commit -m "feat: add GET /api/admin/llm-settings/ollama-models proxy route"
```

---

## Task 3: Admin LLM settings page — Ollama model dropdown

**Files:**
- Modify: `frontend/app/admin/llm-settings/page.tsx`
- Test: `frontend/tests/admin-llm-settings.test.tsx` (extended)

**Interfaces:**
- Consumes: `GET /api/admin/llm-settings/ollama-models?baseUrl=<url>` (Task 2) — `200 { models: string[] }` on success, any other status is treated as failure.
- Produces: nothing — last task in this plan.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `frontend/tests/admin-llm-settings.test.tsx` with:

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
  models?: { status: number; json?: unknown }
}) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const isMe = url.includes('/api/me')
    const isModels = url.includes('/ollama-models')
    const isPut = init?.method === 'PUT'
    const route = isMe ? routes.me : isModels ? routes.models : isPut ? routes.put : routes.get
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

  it('renders a model dropdown populated with fetched models when the saved provider is ollama', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: {
        status: 200,
        json: { provider: 'ollama', model: 'llama3:latest', baseUrl: 'http://localhost:11434', apiKeySet: false },
      },
      models: { status: 200, json: { models: ['llama3:latest', 'mistral:latest'] } },
    })

    render(<AdminLlmSettingsPage />)

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'mistral:latest' })).toBeInTheDocument()
    })
    expect(screen.getByLabelText(/^model$/i).tagName).toBe('SELECT')
    expect(screen.getByDisplayValue('llama3:latest')).toBeInTheDocument()
  })

  it('fetches models when the base URL is edited and blurred while provider is ollama', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: SETTINGS },
      models: { status: 200, json: { models: ['llama3:latest'] } },
    })
    const user = userEvent.setup()

    render(<AdminLlmSettingsPage />)
    await waitFor(() => screen.getByDisplayValue('claude-sonnet-5'))

    await user.selectOptions(screen.getByLabelText(/provider/i), 'ollama')
    await user.type(screen.getByLabelText(/base url/i), 'http://localhost:11434')
    await user.tab()

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'llama3:latest' })).toBeInTheDocument()
    })
  })

  it('falls back to a text input and shows an error when the ollama models fetch fails', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: {
        status: 200,
        json: { provider: 'ollama', model: 'llama3:latest', baseUrl: 'http://localhost:11434', apiKeySet: false },
      },
      models: { status: 502, json: { error: 'could not reach ollama' } },
    })

    render(<AdminLlmSettingsPage />)

    await waitFor(() => {
      expect(screen.getByText('Could not load Ollama models.')).toBeInTheDocument()
    })
    expect(screen.getByLabelText(/^model$/i).tagName).toBe('INPUT')
    expect(screen.getByDisplayValue('llama3:latest')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npx vitest run tests/admin-llm-settings.test.tsx`
Expected: the 5 pre-existing tests PASS unchanged; the 3 new tests FAIL — the page doesn't fetch or render an Ollama model dropdown yet, so the `waitFor` assertions never find their target text/option.

- [ ] **Step 3: Update the page**

Replace the full contents of `frontend/app/admin/llm-settings/page.tsx` with:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useResource, backendFetch } from '../../lib/api'
import TopBar from '../../components/TopBar'

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

  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

  function fetchOllamaModels(url: string) {
    if (url.trim().length === 0) return
    setModelsLoading(true)
    setModelsError(null)

    backendFetch(`/api/admin/llm-settings/ollama-models?baseUrl=${encodeURIComponent(url)}`)
      .then(async (res) => {
        if (res.status !== 200) {
          setOllamaModels([])
          setModelsError('Could not load Ollama models.')
          setModelsLoading(false)
          return
        }
        const body = await res.json().catch(() => ({}))
        const models: string[] = Array.isArray(body.models) ? body.models : []
        if (models.length === 0) {
          setOllamaModels([])
          setModelsError('Could not load Ollama models.')
          setModelsLoading(false)
          return
        }
        setOllamaModels(models)
        setModelsLoading(false)
      })
      .catch(() => {
        setOllamaModels([])
        setModelsError('Could not load Ollama models.')
        setModelsLoading(false)
      })
  }

  useEffect(() => {
    if (settings.data) {
      setProvider(settings.data.provider ?? 'claude')
      setModel(settings.data.model ?? '')
      setBaseUrl(settings.data.baseUrl ?? '')
      if (settings.data.provider === 'ollama' && settings.data.baseUrl) {
        fetchOllamaModels(settings.data.baseUrl)
      }
    }
  }, [settings.data])

  function handleProviderChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value
    setProvider(next)
    if (next === 'ollama') {
      if (baseUrl.trim().length > 0) {
        fetchOllamaModels(baseUrl)
      }
    } else {
      setOllamaModels([])
      setModelsError(null)
      setModelsLoading(false)
    }
  }

  function handleBaseUrlBlur(event: React.FocusEvent<HTMLInputElement>) {
    fetchOllamaModels(event.target.value)
  }

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

  if (me.loading || settings.loading) return <p className="state-message">Loading...</p>
  if (me.error) return <p className="state-message">Something went wrong loading this page.</p>
  if (!me.data) return null
  if (!me.data.isAdmin) return <p className="state-message">Not authorized.</p>
  if (settings.error) return <p className="state-message">Could not load LLM settings.</p>
  if (!settings.data) return null

  const showModelDropdown = provider === 'ollama' && !modelsError

  return (
    <div className="page">
      <TopBar location="admin / llm-settings" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content content-narrow">
        <div>
          <h1 className="page-title">LLM settings</h1>
          <p className="page-subtitle">Choose which provider generates feedback for completed runs.</p>
        </div>

        <form className="panel" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label" htmlFor="provider">
              Provider
            </label>
            <select id="provider" value={provider} onChange={handleProviderChange}>
              <option value="claude">Claude</option>
              <option value="openai">OpenAI</option>
              <option value="openrouter">OpenRouter</option>
              <option value="ollama">Ollama</option>
            </select>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="model">
              Model
            </label>
            {showModelDropdown ? (
              <select
                id="model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={modelsLoading}
              >
                {modelsLoading ? (
                  <option value="">Loading models…</option>
                ) : (
                  ollamaModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))
                )}
              </select>
            ) : (
              <input
                id="model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={provider === 'openrouter' ? 'anthropic/claude-3.5-sonnet' : 'claude-sonnet-5'}
              />
            )}
            {provider === 'ollama' && modelsError && <p className="form-error">{modelsError}</p>}
          </div>

          {provider === 'ollama' && (
            <div className="field">
              <label className="field-label" htmlFor="baseUrl">
                Base URL
              </label>
              <input
                id="baseUrl"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                onBlur={handleBaseUrlBlur}
                placeholder="http://localhost:11434"
              />
            </div>
          )}

          {provider !== 'ollama' && (
            <div className="field">
              <label className="field-label" htmlFor="apiKey">
                API key{settings.data.apiKeySet ? ' (leave blank to keep current key)' : ''}
              </label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
          )}

          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>

          {saveError && <p className="form-error">{saveError}</p>}
          {saved && <p className="form-success">Settings saved.</p>}
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npx vitest run tests/admin-llm-settings.test.tsx`
Expected: PASS, all 8 cases green.

Run the full frontend suite to confirm nothing regressed:
Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/admin/llm-settings/page.tsx frontend/tests/admin-llm-settings.test.tsx
git commit -m "feat: list and select Ollama models in admin LLM settings"
```

---

## Final check

- [ ] Run the full backend suite: `cd backend && npm test` — expect all green.
- [ ] Run the full frontend suite: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test` — expect all green.
- [ ] Run `cd backend && npx tsc --noEmit` and `cd frontend && npx tsc --noEmit` — expect no type errors.
- [ ] Manually confirm against a real local Ollama server (`ollama serve`, with at least one model pulled): opening the admin LLM settings page with Ollama already saved as the provider shows the dropdown populated with real installed models; switching to Ollama from another provider and typing a base URL then tabbing away also populates it; pointing the base URL at a wrong port shows the fallback error and text input.
