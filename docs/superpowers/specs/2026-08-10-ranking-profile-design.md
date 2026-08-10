# Ranking / Perfil Público — Design

> `PLANO_MVP.md`'s only mention: "Ranking / Perfil público — Incluído no v1 (mantido no escopo apesar da recomendação inicial de adiar por falta de massa crítica de usuários)." No further detail existed — this spec defines the feature from scratch. Builds on the existing `Run`/`Challenge`/`User` models and `requireAuth` middleware. Does **not** cover per-challenge leaderboards, badges, pagination, or any moderation/reporting tooling — out of scope for v1.

## Goal

A public, no-login-required ranking of users by total score, and a public profile per user showing which challenges they've attempted and their best score on each. Every user appears by default (opt-out, not opt-in) — maximizes the ranking's critical mass from day one, which is the whole reason this feature stayed in scope despite the recommendation to defer it.

## Scope

In scope:
- `User.hideFromRanking` opt-out flag, toggled from the dashboard.
- Score aggregation: for each user, sum of their best (`MAX`) score per challenge across `completed` runs only — derived at query time, not stored.
- `GET /api/ranking` — public (no `requireAuth`), full sorted list, no pagination.
- `GET /api/users/:username/profile` — public, per-user breakdown by challenge.
- `GET /api/me` gains `hideFromRanking`; new `PUT /api/me` to toggle it.
- Frontend `/ranking` and `/u/[username]` pages (both fully public — no `/api/me` call, `TopBar` always renders in "visitor" mode there).
- A "Hide from public ranking" checkbox on the dashboard.
- A "Ranking" link in `TopBar`, visible to everyone (not gated behind `{username && ...}`).

Explicitly out of scope: per-challenge leaderboards (only one global ranking), pagination (small expected user base per `PLANO_MVP.md`'s own admission), any UI distinction between free and paid users in the ranking (same ruler for both — a free user's incomplete catalog access naturally produces a lower/sparser ranking, which is itself an upsell hook, without needing separate display logic), badges/achievements, and any moderation tooling for the public profile.

## Data Model

One new column on the existing `User` model:

```prisma
model User {
  // ...existing fields...
  hideFromRanking Boolean @default(false)
}
```

No new table. The aggregate score is derived, not stored — it already lives in `Run.score`, and storing a second copy would just be a cache that can drift.

## Score Aggregation

For a user, "total score" = sum of their best score per challenge, counting only `Run`s with `status: 'completed'` (a `pending`/`error`/`timed_out` run has no meaningful score to rank on):

```sql
SELECT userId, SUM(bestScore) AS totalScore, COUNT(*) AS challengesAttempted
FROM (
  SELECT userId, challengeId, MAX(score) AS bestScore
  FROM "Run"
  WHERE status = 'completed'
  GROUP BY userId, challengeId
) best
GROUP BY userId
```

Implemented via Prisma's `groupBy`, not raw SQL, matching the rest of the codebase's Prisma-only convention.

- A user with zero completed runs does not appear in the ranking at all — "hasn't attempted anything" is not the same as "scored 0," and cluttering the ranking with everyone who's merely signed up defeats its purpose.
- `hideFromRanking: true` excludes a user from both the ranking list and their own profile endpoint (the profile 404s — see below).
- Sort: `totalScore DESC, username ASC`. The `username` tiebreaker is arbitrary but deterministic — no extra column needed to track "who reached this score first."

## Backend

New module `backend/src/ranking/` (`service.ts`, `routes.ts`), mirroring the shape of `tos/`.

**`backend/src/ranking/service.ts`**

```ts
export type RankingEntry = {
  userId: string
  username: string
  avatarUrl: string | null
  totalScore: number
  challengesAttempted: number
}
export async function getRanking(prisma: PrismaClient): Promise<RankingEntry[]>

export type UserProfile = {
  username: string
  avatarUrl: string | null
  totalScore: number
  rank: number
  challenges: { challengeId: string; title: string; category: string; points: number; bestScore: number }[]
}
export async function getUserProfile(prisma: PrismaClient, username: string): Promise<UserProfile | null>
```

- `getRanking` — `Run.groupBy({ by: ['userId', 'challengeId'], where: { status: 'completed' }, _max: { score: true } })`, aggregated to per-user totals in application code, filtered to `hideFromRanking: false`, sorted per the tiebreak above. No pagination — returns the complete list.
- `getUserProfile` — looks up the user by `username`. Returns `null` if the user doesn't exist OR has `hideFromRanking: true` — the two cases are indistinguishable to the caller, so hiding never leaks "this user exists but opted out." `rank` is this user's 1-based position in the same ordering `getRanking` produces (computed by finding their `totalScore`'s position, not by calling `getRanking` and scanning — implementation detail for the plan). `challenges` lists every challenge with at least one completed run for this user, each with its `bestScore`.
- `targetUrl` never appears in either return type or any query `select` — it's the candidate's own (or a third party's) infrastructure address and has no reason to be public.

**Routes — public, no `requireAuth`** (`ranking/routes.ts`):
- `GET /api/ranking` → `200 RankingEntry[]`.
- `GET /api/users/:username/profile` → `200 UserProfile`, or `404 { error: 'user_not_found' }` if `getUserProfile` returns `null`.

**Settings — extend `users/routes.ts`:**
- `GET /api/me` response gains `hideFromRanking: boolean`.
- `PUT /api/me` (new route) — `requireAuth`, body `{ hideFromRanking: boolean }`, updates the user and returns the same shape `GET /api/me` returns (so the frontend can reuse one type and one response handler).

## Frontend

**`frontend/app/ranking/page.tsx`** (new): `useResource<RankingEntry[]>('/api/ranking')` only — no `/api/me` call. Renders `<TopBar />` with no props (visitor mode, matching the existing precedent set by `/accept-terms`). A simple table: rank position, avatar, username (linking to `/u/[username]`), total score, challenges attempted. No pagination, no loading skeleton beyond the existing `state-message` pattern.

**`frontend/app/u/[username]/page.tsx`** (new): `useResource<UserProfile>(\`/api/users/${params.username}/profile\`)` — the hook's existing `notFound` handling renders "User not found." for a 404, no new logic needed. Also visitor-mode `TopBar`. Header shows avatar, username, total score, rank. Below it, a list of attempted challenges (title, category badge, points, best score) — reuses the existing `badge-category`/`challenge-row`-style classes from the dashboard's challenge list for visual consistency.

**Dashboard** (`frontend/app/dashboard/page.tsx`, modified): `Me` type gains `hideFromRanking: boolean`. A checkbox near the bottom of the page, labeled "Hide from public ranking," initialized from `me.data.hideFromRanking`, firing `PUT /api/me { hideFromRanking: <new value> }` on change (optimistic toggle, revert on failure — exact UX left to the implementation plan).

**`TopBar`** (modified): a "Ranking" link added outside the `{username && (...)}` block (next to the brand/`location` area) so it's visible whether or not the visitor is logged in — this is the one nav element in the whole app meant for anonymous visitors too.

## Error Handling

Follows the existing per-route try/catch + `{ error: "message" }` pattern. No new error classes.

## Testing Strategy

Mirrors the existing suite shape (Jest + Supertest against real Postgres on the backend; Vitest + Testing Library on the frontend):

- `ranking.service.test.ts` — empty ranking with no runs; a user with multiple completed runs across challenges sums correctly; a `pending`/`error` run is excluded; a user with only non-completed runs doesn't appear; `hideFromRanking: true` excludes a user; tie ordering by username.
- `ranking.routes.test.ts` — `GET /api/ranking` requires no auth and returns `200` for an anonymous request; `GET /api/users/:username/profile` returns `404` for a nonexistent user and for a hidden user (same status/body for both); returns the full challenge breakdown for a visible user.
- `me.routes.test.ts` (extended) — `GET /api/me` includes `hideFromRanking: false` by default; `PUT /api/me` updates it and the change is reflected on the next `GET`; `PUT` requires auth.
- `ranking-page.test.tsx` / `user-profile.test.tsx` — render the list/profile from a mocked `fetch`, no `/api/me` call is made, 404 renders "User not found."
- `dashboard.test.tsx` (extended) — checkbox reflects `hideFromRanking`, toggling it calls `PUT /api/me` with the new value.

## Open Items for the Implementation Plan

- Exact optimistic-update/revert-on-failure behavior for the dashboard checkbox — this spec establishes the endpoint and intent, not the precise loading-state UX.
- Whether `getUserProfile`'s `rank` computation is a second `groupBy` query or derived from the same data `getRanking` would produce — an implementation detail, not a design decision.
