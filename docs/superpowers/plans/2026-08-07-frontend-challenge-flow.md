# Frontend Challenge Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in user browse the challenge catalog from `/dashboard`, submit their API's URL on `/challenges/[id]`, and watch the run resolve to a score on `/runs/[id]` — using only the Node orchestrator APIs that already exist and pass their backend test suite.

**Architecture:** Three client-side Next.js 14 app-router pages (`'use client'`), each talking directly to the Express backend over `fetch` with `credentials: 'include'`, matching the existing `/dashboard` pattern exactly. A shared `frontend/app/lib/api.ts` (`backendFetch` + a `useResource` hook covering loading/error/404/401-redirect/polling) replaces the fetch boilerplate that would otherwise be duplicated across all four backend-talking pages.

**Tech Stack:** Next.js 14 (app router), React 18, TypeScript, Vitest + `@testing-library/react` (existing conventions from the Foundation plan's frontend setup).

## Global Constraints

- No new backend endpoints — this plan only consumes routes that already exist and are tested: `GET /api/challenges`, `GET /api/challenges/:id`, `POST /api/runs`, `GET /api/runs/:id` (design spec `docs/superpowers/specs/2026-08-07-frontend-challenge-flow-design.md`).
- No CSS or visual styling — matches the current unstyled convention of `/` and `/dashboard` (design spec, "Scope").
- Code style follows the existing `frontend/app/` conventions exactly: no semicolons, single quotes, 2-space indent, `'use client'` at the top of every page, relative imports (no path aliases are configured).
- No new environment variables — reuses `NEXT_PUBLIC_BACKEND_URL`, already required by `/` and `/dashboard`.
- Free-tier attempt status is never shown proactively in the catalog — it only surfaces via the `403` returned from `POST /api/runs` (design spec, "Scope").
- Tests follow the existing `frontend/tests/dashboard.test.tsx` pattern: Vitest + `@testing-library/react`, `global.fetch` mocked per test, `next/navigation`'s `useRouter` mocked per test.

---

## Task 1: Shared backend-fetch hook + challenge list on the dashboard

**Files:**
- Create: `frontend/app/lib/api.ts`
- Modify: `frontend/app/dashboard/page.tsx`
- Test: `frontend/tests/dashboard.test.tsx` (modify — existing file, mocks need to route by URL since the page will make two concurrent backend calls)

**Interfaces:**
- Consumes: nothing from other tasks in this plan.
- Produces: `backendFetch(path: string, init?: RequestInit): Promise<Response>`, `UseResourceOptions<T> = { redirectOn401?: boolean; pollMs?: number; stopPolling?: (data: T) => boolean }`, `UseResourceResult<T> = { data: T | null; loading: boolean; error: boolean; notFound: boolean }`, `useResource<T>(path: string, opts?: UseResourceOptions<T>): UseResourceResult<T>` — all from `frontend/app/lib/api.ts`. Used by Task 2 and Task 3.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `frontend/tests/dashboard.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import DashboardPage from '../app/dashboard/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
}))

const ME_RESPONSE = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: false }
const CHALLENGES_RESPONSE = [
  { id: 'todo-api-crud', title: 'Build a Todo CRUD API', category: 'crud', points: 25 },
]

function mockFetch(routes: Record<string, { status: number; json?: unknown }>) {
  global.fetch = vi.fn((url: string) => {
    const match = Object.keys(routes).find((path) => url.includes(path))
    const route = match ? routes[match] : { status: 500 }
    return Promise.resolve({
      status: route.status,
      json: async () => route.json,
    })
  }) as any
}

describe('DashboardPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
  })

  it('shows the username when the session is valid', async () => {
    mockFetch({
      '/api/me': { status: 200, json: ME_RESPONSE },
      '/api/challenges': { status: 200, json: [] },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/welcome, octocat/i)).toBeInTheDocument()
    })
  })

  it('redirects to the login page when the session is missing', async () => {
    mockFetch({
      '/api/me': { status: 401 },
      '/api/challenges': { status: 200, json: [] },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/')
    })
  })

  it('shows an error message instead of an infinite spinner when the backend request fails', async () => {
    mockFetch({
      '/api/me': { status: 500 },
      '/api/challenges': { status: 200, json: [] },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/something went wrong loading your dashboard/i)).toBeInTheDocument()
    })

    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
  })

  it('renders the challenge list', async () => {
    mockFetch({
      '/api/me': { status: 200, json: ME_RESPONSE },
      '/api/challenges': { status: 200, json: CHALLENGES_RESPONSE },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/build a todo crud api/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: /build a todo crud api/i })).toHaveAttribute(
      'href',
      '/challenges/todo-api-crud'
    )
  })

  it('shows a message when the challenge list fails to load', async () => {
    mockFetch({
      '/api/me': { status: 200, json: ME_RESPONSE },
      '/api/challenges': { status: 500 },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/could not load challenges/i)).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm test -- dashboard.test.tsx`
Expected: FAIL — the 2 new tests fail because `DashboardPage` doesn't fetch or render challenges yet (the 3 pre-existing tests still pass, since the old page's single `/api/me` fetch matches the new URL-routing mock fine).

- [ ] **Step 3: Implement the shared hook**

Create `frontend/app/lib/api.ts`:

```ts
'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

export function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL
  return fetch(`${backendUrl}${path}`, { ...init, credentials: 'include' })
}

export type UseResourceOptions<T> = {
  redirectOn401?: boolean
  pollMs?: number
  stopPolling?: (data: T) => boolean
}

export type UseResourceResult<T> = {
  data: T | null
  loading: boolean
  error: boolean
  notFound: boolean
}

export function useResource<T>(path: string, opts: UseResourceOptions<T> = {}): UseResourceResult<T> {
  const router = useRouter()
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    function stopInterval() {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    function load() {
      backendFetch(path)
        .then((res) => {
          if (res.status === 401 && opts.redirectOn401) {
            router.replace('/')
            stopInterval()
            return null
          }
          if (res.status === 404) {
            setNotFound(true)
            setLoading(false)
            stopInterval()
            return null
          }
          if (res.status !== 200) {
            throw new Error(`unexpected status ${res.status}`)
          }
          return res.json()
        })
        .then((json) => {
          if (json === null || json === undefined) return
          setData(json)
          setLoading(false)
          if (opts.pollMs && opts.stopPolling && opts.stopPolling(json)) {
            stopInterval()
          }
        })
        .catch(() => {
          setError(true)
          setLoading(false)
          stopInterval()
        })
    }

    load()

    if (opts.pollMs) {
      intervalRef.current = setInterval(load, opts.pollMs)
    }

    return stopInterval
  }, [path])

  return { data, loading, error, notFound }
}
```

- [ ] **Step 4: Refactor the dashboard to use the hook and list challenges**

Replace the full contents of `frontend/app/dashboard/page.tsx`:

```tsx
'use client'

import { useResource } from '../lib/api'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
}

type Challenge = {
  id: string
  title: string
  category: string
  points: number
}

export default function DashboardPage() {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const challenges = useResource<Challenge[]>('/api/challenges')

  if (me.loading) return <p>Loading...</p>
  if (me.error) return <p>Something went wrong loading your dashboard.</p>
  if (!me.data) return null

  return (
    <main>
      <h1>Welcome, {me.data.username}</h1>
      {me.data.isAdmin && <p>Admin access enabled</p>}
      <a href={`${process.env.NEXT_PUBLIC_BACKEND_URL}/auth/logout`}>Logout</a>

      <h2>Challenges</h2>
      {challenges.loading && <p>Loading challenges...</p>}
      {challenges.error && <p>Could not load challenges.</p>}
      {challenges.data && (
        <ul>
          {challenges.data.map((challenge) => (
            <li key={challenge.id}>
              <a href={`/challenges/${challenge.id}`}>
                {challenge.title} ({challenge.category}, {challenge.points} pts)
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npm test -- dashboard.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add frontend/app/lib/api.ts frontend/app/dashboard/page.tsx frontend/tests/dashboard.test.tsx
git commit -m "feat: extract shared backend-fetch hook, list challenges on the dashboard"
```

---

## Task 2: Challenge detail + submission form

**Files:**
- Create: `frontend/app/challenges/[id]/page.tsx`
- Modify: `frontend/package.json` (add `@testing-library/user-event`)
- Test: `frontend/tests/challenges-detail.test.tsx`

**Interfaces:**
- Consumes: `useResource`, `backendFetch` (Task 1, `frontend/app/lib/api.ts`).
- Produces: nothing new for other tasks — the `/challenges/[id]` route this task creates is already linked to from Task 1's dashboard list.

- [ ] **Step 1: Add the user-event testing dependency**

Run: `cd frontend && npm install -D @testing-library/user-event`

- [ ] **Step 2: Write the failing tests**

Create `frontend/tests/challenges-detail.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import ChallengeDetailPage from '../app/challenges/[id]/page'

const pushMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}))

const CHALLENGE = { id: 'todo-api-crud', title: 'Build a Todo CRUD API', category: 'crud', points: 25 }

function mockFetch(routes: { get?: { status: number; json?: unknown }; post?: { status: number; json?: unknown } }) {
  global.fetch = vi.fn((_url: string, init?: RequestInit) => {
    const route = init?.method === 'POST' ? routes.post : routes.get
    const status = route?.status ?? 500
    return Promise.resolve({
      status,
      json: async () => route?.json,
    })
  }) as any
}

describe('ChallengeDetailPage', () => {
  beforeEach(() => {
    pushMock.mockReset()
  })

  it('renders the challenge title and points', async () => {
    mockFetch({ get: { status: 200, json: CHALLENGE } })

    render(<ChallengeDetailPage params={{ id: 'todo-api-crud' }} />)

    await waitFor(() => {
      expect(screen.getByText('Build a Todo CRUD API')).toBeInTheDocument()
    })
    expect(screen.getByText(/25 pts/)).toBeInTheDocument()
  })

  it('submits and navigates to the run status page on success', async () => {
    mockFetch({
      get: { status: 200, json: CHALLENGE },
      post: { status: 202, json: { runId: 'run-123', status: 'pending' } },
    })
    const user = userEvent.setup()

    render(<ChallengeDetailPage params={{ id: 'todo-api-crud' }} />)
    await waitFor(() => screen.getByText('Build a Todo CRUD API'))

    await user.type(screen.getByLabelText(/api url/i), 'https://candidate.example.com')
    await user.click(screen.getByLabelText(/authorized to test/i))
    await user.click(screen.getByRole('button', { name: /submit/i }))

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/runs/run-123')
    })
  })

  it('shows the server error message on a 400', async () => {
    mockFetch({
      get: { status: 200, json: CHALLENGE },
      post: { status: 400, json: { error: 'targetUrl must be a valid http(s) URL' } },
    })
    const user = userEvent.setup()

    render(<ChallengeDetailPage params={{ id: 'todo-api-crud' }} />)
    await waitFor(() => screen.getByText('Build a Todo CRUD API'))

    await user.type(screen.getByLabelText(/api url/i), 'not-a-url')
    await user.click(screen.getByLabelText(/authorized to test/i))
    await user.click(screen.getByRole('button', { name: /submit/i }))

    await waitFor(() => {
      expect(screen.getByText('targetUrl must be a valid http(s) URL')).toBeInTheDocument()
    })
  })

  it('shows the server error message on a 403 free-tier limit', async () => {
    mockFetch({
      get: { status: 200, json: CHALLENGE },
      post: { status: 403, json: { error: 'free tier is limited to 2 challenges' } },
    })
    const user = userEvent.setup()

    render(<ChallengeDetailPage params={{ id: 'todo-api-crud' }} />)
    await waitFor(() => screen.getByText('Build a Todo CRUD API'))

    await user.type(screen.getByLabelText(/api url/i), 'https://candidate.example.com')
    await user.click(screen.getByLabelText(/authorized to test/i))
    await user.click(screen.getByRole('button', { name: /submit/i }))

    await waitFor(() => {
      expect(screen.getByText('free tier is limited to 2 challenges')).toBeInTheDocument()
    })
  })

  it('shows a generic message when the submit request fails on the network', async () => {
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.reject(new Error('network down'))
      return Promise.resolve({ status: 200, json: async () => CHALLENGE })
    }) as any
    const user = userEvent.setup()

    render(<ChallengeDetailPage params={{ id: 'todo-api-crud' }} />)
    await waitFor(() => screen.getByText('Build a Todo CRUD API'))

    await user.type(screen.getByLabelText(/api url/i), 'https://candidate.example.com')
    await user.click(screen.getByLabelText(/authorized to test/i))
    await user.click(screen.getByRole('button', { name: /submit/i }))

    await waitFor(() => {
      expect(screen.getByText('Something went wrong submitting your run.')).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npm test -- challenges-detail.test.tsx`
Expected: FAIL — `Cannot find module '../app/challenges/[id]/page'`

- [ ] **Step 4: Implement the challenge detail + submit page**

Create `frontend/app/challenges/[id]/page.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useResource, backendFetch } from '../../lib/api'

type ChallengeDetail = {
  id: string
  title: string
  category: string
  points: number
}

export default function ChallengeDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const challenge = useResource<ChallengeDetail>(`/api/challenges/${params.id}`)
  const [targetUrl, setTargetUrl] = useState('')
  const [confirmedAuthorization, setConfirmedAuthorization] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitError(null)
    setSubmitting(true)

    backendFetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: params.id, targetUrl, confirmedAuthorization }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 202) {
          router.push(`/runs/${body.runId}`)
          return
        }
        if (res.status === 400 || res.status === 403) {
          setSubmitError(body.error ?? 'Submission was rejected.')
          setSubmitting(false)
          return
        }
        setSubmitError('Something went wrong submitting your run.')
        setSubmitting(false)
      })
      .catch(() => {
        setSubmitError('Something went wrong submitting your run.')
        setSubmitting(false)
      })
  }

  if (challenge.loading) return <p>Loading...</p>
  if (challenge.error) return <p>Could not load this challenge.</p>
  if (!challenge.data) return null

  return (
    <main>
      <h1>{challenge.data.title}</h1>
      <p>
        {challenge.data.category} &middot; {challenge.data.points} pts
      </p>

      <form onSubmit={handleSubmit}>
        <label>
          API URL
          <input
            type="url"
            value={targetUrl}
            onChange={(event) => setTargetUrl(event.target.value)}
            required
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={confirmedAuthorization}
            onChange={(event) => setConfirmedAuthorization(event.target.checked)}
          />
          I own or am authorized to test this URL
        </label>
        <button type="submit" disabled={submitting}>
          Submit
        </button>
      </form>

      {submitError && <p>{submitError}</p>}
    </main>
  )
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npm test -- challenges-detail.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add frontend/app/challenges frontend/package.json frontend/package-lock.json frontend/tests/challenges-detail.test.tsx
git commit -m "feat: add challenge detail page with run submission form"
```

---

## Task 3: Run status page with polling

**Files:**
- Create: `frontend/app/runs/[id]/page.tsx`
- Test: `frontend/tests/runs-status.test.tsx`

**Interfaces:**
- Consumes: `useResource` (Task 1, `frontend/app/lib/api.ts`), including its `pollMs`/`stopPolling`/`notFound` behavior.
- Produces: nothing new for other tasks — this is the plan's final page, already linked to from Task 2's successful-submit redirect.

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/runs-status.test.tsx`:

```tsx
import { render, screen, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import RunStatusPage from '../app/runs/[id]/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
}))

function jsonResponse(status: number, json?: unknown) {
  return Promise.resolve({ status, json: async () => json })
}

describe('RunStatusPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls while pending and stops once completed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse(200, { runId: 'run-1', status: 'pending', score: null, checks: null, error: null })
      )
      .mockImplementationOnce(() =>
        jsonResponse(200, {
          runId: 'run-1',
          status: 'completed',
          score: 100,
          checks: [{ name: 'check one', status: 'passed', points: 10, pointsEarned: 10 }],
          error: null,
        })
      )
    global.fetch = fetchMock as any

    render(<RunStatusPage params={{ id: 'run-1' }} />)

    await waitFor(() => expect(screen.getByText(/running your submission/i)).toBeInTheDocument())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    await waitFor(() => expect(screen.getByText('Score: 100')).toBeInTheDocument())

    const callsAfterCompletion = fetchMock.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(fetchMock.mock.calls.length).toBe(callsAfterCompletion)
  })

  it('shows the error message for a failed run', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        await jsonResponse(200, {
          runId: 'run-2',
          status: 'error',
          score: null,
          checks: null,
          error: 'challenge YAML failed to parse',
        })
      ) as any

    render(<RunStatusPage params={{ id: 'run-2' }} />)

    await waitFor(() => {
      expect(screen.getByText('challenge YAML failed to parse')).toBeInTheDocument()
    })
  })

  it('shows a timed-out message for a stale pending run', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        await jsonResponse(200, {
          runId: 'run-3',
          status: 'timed_out',
          score: null,
          checks: null,
          error: null,
        })
      ) as any

    render(<RunStatusPage params={{ id: 'run-3' }} />)

    await waitFor(() => {
      expect(screen.getByText(/taking longer than expected/i)).toBeInTheDocument()
    })
  })

  it('shows "Run not found" for a 404 without redirecting', async () => {
    global.fetch = vi.fn().mockResolvedValue(await jsonResponse(404, { error: 'run_not_found' })) as any

    render(<RunStatusPage params={{ id: 'does-not-exist' }} />)

    await waitFor(() => {
      expect(screen.getByText('Run not found.')).toBeInTheDocument()
    })
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('redirects to the login page when the session is missing', async () => {
    global.fetch = vi.fn().mockResolvedValue(await jsonResponse(401)) as any

    render(<RunStatusPage params={{ id: 'run-4' }} />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/')
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm test -- runs-status.test.tsx`
Expected: FAIL — `Cannot find module '../app/runs/[id]/page'`

- [ ] **Step 3: Implement the run status page**

Create `frontend/app/runs/[id]/page.tsx`:

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
}

function isTerminal(run: RunStatus): boolean {
  return run.status !== 'pending'
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
      </main>
    )
  }

  if (run.data.status === 'timed_out') {
    return <p>This is taking longer than expected — check back later.</p>
  }

  return <p>{run.data.error}</p>
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm test -- runs-status.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: PASS (all suites — page, dashboard, challenges-detail, runs-status)

- [ ] **Step 6: Commit**

```bash
git add frontend/app/runs frontend/tests/runs-status.test.tsx
git commit -m "feat: add run status page with polling until a terminal state"
```
