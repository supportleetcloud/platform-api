# Frontend Challenge Flow — Design

> Subsystem #4 of the platform (see `PLANO_MVP.md`). Consumes the Node orchestrator's already-built APIs (`docs/superpowers/specs/2026-08-06-node-orchestrator-design.md`): challenge catalog, run submission, run polling. Adds no new backend endpoints. Does **not** cover styling/visual design, ranking/public profile, admin panel, or billing UI — those are separate future work.

## Goal

Let a logged-in user, from the existing dashboard, browse the challenge catalog, pick one, submit their API's URL, and watch the run resolve to a score — using only APIs that already exist and pass their backend test suite.

## Scope

In scope:
- Extend `/dashboard` to list challenges (`GET /api/challenges`).
- New `/challenges/[id]` — challenge detail + submission form (`GET /api/challenges/:id`, `POST /api/runs`).
- New `/runs/[id]` — run status with polling (`GET /api/runs/:id`).
- A small shared fetch/hook helper in `frontend/app/lib/api.ts` to remove duplication across the four pages that now talk to the backend (`/`, `/dashboard`, `/challenges/[id]`, `/runs/[id]`).

Explicitly out of scope: any CSS/visual styling (matches the current unstyled convention — a separate future pass), run history/list-of-past-runs view, admin editing of challenges, free-tier status displayed proactively in the catalog (the backend doesn't expose per-user attempt counts on `GET /api/challenges`; free-tier limits only surface reactively via a `403` on submit — adding that would mean a new backend endpoint, out of scope here).

## Architecture

Pure client-side Next.js 14 app-router pages (`'use client'`), matching the existing `/dashboard` pattern exactly — no server components, no new backend surface:

```
/dashboard  ──GET /api/challenges──►  list, links to /challenges/[id]
/challenges/[id]  ──GET /api/challenges/:id──►  detail + submit form
                  ──POST /api/runs──►  202 { runId } ──► router.push(/runs/[runId])
/runs/[id]  ──GET /api/runs/:id (polled every 2s while pending)──►  status/score/checks
```

Two alternatives considered and rejected:
- **Submit form and run status on the same page** (no `/runs/[id]` route) — rejected per user preference; a dedicated route gives a shareable/bookmarkable URL and a natural place to add run history later.
- **Server components fetching at request time** — the rest of the app (dashboard, auth) is entirely client-side against a separately-hosted Express backend using session cookies; switching data-fetching model for only the new pages would be inconsistent and complicate cookie forwarding for no benefit at this scale.

## Shared helper (`frontend/app/lib/api.ts`)

Today `/dashboard` inline-duplicates: build backend URL, `fetch` with `credentials: 'include'`, branch on `401`/non-200/network error, track `loading`/`error` state. Three more pages need the same shape, so this plan extracts it rather than copy-pasting a fourth and fifth time:

```ts
export function backendFetch(path: string, init?: RequestInit): Promise<Response>
// fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}${path}`, { ...init, credentials: 'include' })

export function useResource<T>(path: string, opts?: {
  redirectOn401?: boolean       // default false; dashboard and /runs/[id] pass true
  pollMs?: number               // if set, re-fetches on this interval
  stopPolling?: (data: T) => boolean  // polling stops once this returns true
}): { data: T | null; loading: boolean; error: boolean }
```

- `/dashboard`'s `GET /api/me` call and `/runs/[id]`'s `GET /api/runs/:id` call use `redirectOn401: true` (both routes are `requireAuth`-protected server-side).
- `/dashboard`'s `GET /api/challenges` call and `/challenges/[id]`'s `GET /api/challenges/:id` call omit it (both are public routes) — a `401` there isn't an expected case in practice, but the hook simply won't special-case it if it ever happened (falls into the generic `error` branch).
- `/runs/[id]` passes `pollMs: 2000` and `stopPolling: (run) => run.status !== 'pending'`.

`POST /api/runs` (the submit action) is a one-off imperative call on form submit, not a `useResource` read — it uses `backendFetch` directly.

This is the one deliberate refactor bundled into this plan: `/dashboard`'s existing `GET /api/me` fetch is rewritten to use `useResource`, so all four backend-talking call sites share one implementation instead of three duplicates of a fourth pattern.

## Pages

### `/dashboard` (modified)

Unchanged: welcome message, admin note, logout link, `GET /api/me` (now via `useResource('/api/me', { redirectOn401: true })`).

Added: `useResource<Challenge[]>('/api/challenges')` where `Challenge = {id, title, category, points}`. Renders a list; each item is a link to `/challenges/${id}` showing title, category, points. Loading/error states follow the same `<p>` pattern already used for the `/api/me` fetch.

### `/challenges/[id]` (new)

`useResource<ChallengeDetail>('/api/challenges/' + id)` for title/category/points header.

Form state: `targetUrl` (text input), `confirmedAuthorization` (checkbox, unchecked by default), disabled submit button while a request is in flight. On submit:

```
POST /api/runs { challengeId: id, targetUrl, confirmedAuthorization }
```

- `202` → `router.push('/runs/' + body.runId)`.
- `400` → inline message from `body.error` (covers missing/invalid `targetUrl`, unchecked `confirmedAuthorization`).
- `403` → inline message from `body.error` (free-tier limit — the only place free-tier ever surfaces in this UI).
- `500` / `502` → inline generic message ("Something went wrong submitting your run.").
- Network failure (fetch throws) → same generic message as above.

Unauthenticated user landing here directly: `POST /api/runs` naturally 401s (server-side `requireAuth`); treated as the generic submit-error case rather than a special redirect, since this page itself doesn't require a prior authed GET (the challenge detail fetch is public). Revisit if this proves confusing in practice — noted as an open item below.

### `/runs/[id]` (new)

`useResource<RunStatus>('/api/runs/' + id, { redirectOn401: true, pollMs: 2000, stopPolling: (run) => run.status !== 'pending' })`.

Render by `status`:
- `pending` → "Running your submission..." (loading indicator, matches existing `Loading...` convention).
- `completed` → score, and a list of `checks` (each: name, status, points, pointsEarned).
- `error` → the `error` message.
- `timed_out` → "This is taking longer than expected — check back later." (no auto-retry; user can refresh, which re-triggers the same poll-until-terminal logic against the still-`pending` DB row).
- `404` response (not-found or not-owner, both surfaced identically by the backend) → "Run not found." No redirect — this isn't necessarily an auth problem.

## Error Handling

No global error boundary added. Every page follows the three-state pattern already established by `/dashboard`: `loading` → render `<p>Loading...</p>`; `error` (network failure or unexpected status) → render a generic `<p>` message; success → render real content. Expected non-200s that carry a meaningful `body.error` (submit's `400`/`403`, run's `404`) are handled as their own explicit states, not lumped into the generic error branch.

## Config

No new env vars — reuses `NEXT_PUBLIC_BACKEND_URL`, already required by `/` and `/dashboard`.

## Testing Strategy

Same pattern as `frontend/tests/dashboard.test.tsx` (Vitest + Testing Library, `global.fetch` mocked, `next/navigation` mocked):

- `dashboard.test.tsx` (extended) — renders the challenge list; existing `/api/me` cases unaffected by the `useResource` refactor.
- `challenges-detail.test.tsx` (new) — renders challenge header; submit success calls `router.push` with the right path; `400`/`403` show the server's `error` message; network failure shows the generic message.
- `runs-status.test.tsx` (new) — `pending` → `completed` transition stops polling (fake timers, `vi.useFakeTimers`); `error` and `timed_out` render correctly; `404` shows not-found without redirecting; `401` redirects to `/`.
- No dedicated unit test file for `lib/api.ts` — its behavior is exercised through the page tests above, matching the existing convention of no standalone tests for inline logic.

## Open Items for the Implementation Plan

- Whether an unauthenticated user landing directly on `/challenges/[id]` should be redirected before they fill out the form, versus discovering the `401` only on submit (current design: only on submit, since the GET here is public and adding an auth check would mean a second `/api/me` round-trip per page). Revisit if it proves confusing during implementation/testing.
- Exact route for Next.js dynamic segments — confirm `app/challenges/[id]/page.tsx` and `app/runs/[id]/page.tsx` naming against the Next 14 app-router convention already used elsewhere in `frontend/app/`.
