# Terms of Use (ToS) — Design

> Painel Admin item #2 of `PLANO_MVP.md` ("Termos de Uso"). Builds on `requireAdmin` (added by the AI Feedback Engine / LLM admin config work, `docs/superpowers/specs/2026-08-07-ai-feedback-engine-design.md`). Does **not** cover subscription pricing, Stripe/billing, or ranking/public profile — separate future work.

## Goal

Admin can publish/edit ToS content from a panel. Every user must accept the current version before using the app, tracked as checkbox + version + timestamp. Editing the text later never retroactively invalidates a prior acceptance — but a *new* published version does require existing users to accept again on their next login, since untracked drift between "accepted version" and "current version" would make the versioning pointless.

## Scope

In scope:
- `TosVersion` / `TosAcceptance` data model.
- `GET/POST /api/tos/current`, `POST /api/tos/accept` — end-user acceptance flow.
- `GET/POST /api/admin/tos/versions` — admin publish/history, mounted in the existing `admin/routes.ts`.
- `requireTosAccepted` middleware gating `challenges/routes.ts` and `runs/routes.ts`.
- `/api/me` gains `tosAcceptanceRequired: boolean`.
- Frontend `/accept-terms` interstitial page + `useTosGate` hook wired into `dashboard`, `challenges/[id]`, `runs/[id]`.
- Frontend `/admin/tos` panel (list history, publish new version).

Explicitly out of scope: legal review of ToS wording (checkbox is the minimum viable acceptance per `PLANO_MVP.md`), draft/preview workflow before publish (publish is immediate, same pattern as `LlmSettings`), markdown/rich-text rendering of content (plain text only), rate limiting or throttling of `/api/tos/accept`.

## Data Model (additions to `backend/prisma/schema.prisma`)

```prisma
model TosVersion {
  id          String   @id @default(uuid())
  content     String   @db.Text
  publishedAt DateTime @default(now())

  acceptances TosAcceptance[]
}

model TosAcceptance {
  id           String   @id @default(uuid())
  userId       String
  tosVersionId String
  acceptedAt   DateTime @default(now())

  user       User       @relation(fields: [userId], references: [id])
  tosVersion TosVersion @relation(fields: [tosVersionId], references: [id])

  @@unique([userId, tosVersionId])
}
```

Each admin publish creates a new, immutable `TosVersion` row — editing never mutates a past row, preserving the exact text a given `TosAcceptance` was made against for audit purposes. "Current version" is derived (`ORDER BY publishedAt DESC LIMIT 1`), not a flag column, so there's nothing to unset on publish. Zero `TosVersion` rows (before the admin's first publish) means the gate is inert — nobody is blocked, since there's nothing to show or accept. A real launch publishes an initial version via the admin panel before opening signups; no seed script is added for this (an admin action, not fixture data).

## Backend

New module `backend/src/tos/` (`service.ts`, `routes.ts`), following the existing `llm/` and `admin/` module shape.

**`backend/src/tos/service.ts`**

```ts
export async function getCurrentVersion(prisma: PrismaClient): Promise<TosVersion | null>
export async function acceptCurrentVersion(
  prisma: PrismaClient,
  userId: string,
  tosVersionId: string
): Promise<{ kind: 'ok' } | { kind: 'stale_version' }>
export async function isTosAcceptanceRequired(prisma: PrismaClient, userId: string): Promise<boolean>
export async function listVersions(prisma: PrismaClient): Promise<TosVersion[]>
export async function publishVersion(prisma: PrismaClient, content: string): Promise<TosVersion>
```

`isTosAcceptanceRequired` — `false` if no `TosVersion` exists; otherwise `true` unless a `TosAcceptance` exists for `(userId, currentVersion.id)`. `acceptCurrentVersion` re-derives the current version server-side and compares against the caller's `tosVersionId`; a mismatch (admin published a newer version between page load and submit) returns `stale_version` instead of writing — prevents recording acceptance of a version that's no longer current. The write itself is an upsert on the `@@unique([userId, tosVersionId])` constraint, making a double-submit idempotent.

**Routes — end user** (`requireAuth`, in `tos/routes.ts`):
- `GET /api/tos/current` → `200 { id, content, publishedAt }`, or `404 { error: 'tos_not_configured' }` if nothing published yet.
- `POST /api/tos/accept` — body `{ tosVersionId }`. `200 { ok: true }` on success; `409 { error: 'stale_version' }` on mismatch; `400` if `tosVersionId` missing.

**Routes — admin** (`requireAuth`, `requireAdmin`, added to existing `admin/routes.ts`):
- `GET /api/admin/tos/versions` → `200 [{ id, content, publishedAt }, ...]`, newest first.
- `POST /api/admin/tos/versions` — body `{ content }`. `400 { error: 'content_required' }` if blank/whitespace-only; otherwise `201` with the new version.

**Gate middleware** (`backend/src/tos/middleware.ts`):

```ts
export function requireTosAccepted(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as { id: string } | undefined
    if (!user) { res.status(401).json({ error: 'not_authenticated' }); return }
    if (await isTosAcceptanceRequired(prisma, user.id)) {
      res.status(403).json({ error: 'tos_required' })
      return
    }
    next()
  }
}
```

Chained after `requireAuth` in `challenges/routes.ts` and `runs/routes.ts` only — the two routers that represent actually *using* the platform. Deliberately **not** applied to `/api/me`, `/api/tos/*`, or any `/api/admin/*` route: `/api/me` is exactly what the frontend polls to *learn* the gate state (so it can't itself be gated), and an admin must always retain access to their own panel regardless of a ToS version they haven't personally re-accepted.

**`/api/me`** (`users/routes.ts`) gains one field:

```ts
res.json({
  id: user.id,
  username: user.username,
  avatarUrl: user.avatarUrl,
  isAdmin: user.isAdmin,
  tosAcceptanceRequired: await isTosAcceptanceRequired(prisma, user.id),
})
```

This is the primary signal the frontend uses to redirect — the `403 tos_required` from the gated routers is defense-in-depth against direct API calls (e.g. `curl`), not the main UX path.

## Frontend

**`frontend/app/lib/api.ts`** gains a small shared hook:

```ts
export function useTosGate(me: UseResourceResult<{ tosAcceptanceRequired: boolean }>) {
  const router = useRouter()
  useEffect(() => {
    if (me.data?.tosAcceptanceRequired) router.replace('/accept-terms')
  }, [me.data])
}
```

Called alongside the existing `useResource<Me>('/api/me', { redirectOn401: true })` on `dashboard`, `challenges/[id]`, and `runs/[id]` — one extra line per page, matching the codebase's existing per-page pattern rather than a global layout wrapper.

**`frontend/app/accept-terms/page.tsx`** (new):
- Fetches `/api/me` (`redirectOn401: true`) and `/api/tos/current`.
- If `me.data.tosAcceptanceRequired === false`, redirects to `/dashboard` immediately (blocks navigating here after already accepting).
- If `/api/tos/current` is `404 tos_not_configured`, redirects to `/dashboard` (nothing to accept — matches the inert-gate case in the data model).
- Renders `content` as plain preformatted text (`white-space: pre-wrap`; no markdown rendering — plain text is sufficient per scope).
- Checkbox "I have read and accept the Terms of Use", unchecked by default; "Continue" button disabled until checked.
- Submit → `POST /api/tos/accept { tosVersionId: current.id }`. On `409 stale_version`, refetches `/api/tos/current` and shows "The terms were updated — please review the new version" instead of navigating away. On `200`, `router.replace('/dashboard')`.

**`frontend/app/admin/tos/page.tsx`** (new, same shape as `admin/llm-settings/page.tsx`):
- `useResource<Me>('/api/me', { redirectOn401: true })`; if `!me.data.isAdmin`, renders "Not authorized." (no redirect — authorization failure, not authentication).
- `useResource<TosVersion[]>('/api/admin/tos/versions')` renders history, newest entry labeled "Current".
- Textarea + "Publish new version" button → `POST /api/admin/tos/versions`; on success, clears the textarea and refetches the list.
- `TopBar.tsx` admin nav gains a link to `/admin/tos` next to the existing `/admin/llm-settings` link.

## Error Handling

Follows the existing per-route try/catch + `{ error: "message" }` pattern — no new global error middleware. `acceptCurrentVersion`'s `stale_version` case is an expected, user-facing outcome (not a server error) and is surfaced as `409`, not `500`.

## Testing Strategy

Mirrors the existing suite shape (Jest + Supertest, Prisma injected via `deps`; Vitest + Testing Library on the frontend):

- `tos.service.test.ts` — `getCurrentVersion` returns `null` with zero rows and the newest row with several; `isTosAcceptanceRequired` is `false` with no versions, `false` after accepting the current version, `true` after a newer version is published; `acceptCurrentVersion` upserts idempotently on double-submit and returns `stale_version` when called with a non-current id.
- `tos.routes.test.ts` — `GET /api/tos/current` returns `404` before any publish, `200` after; `POST /api/tos/accept` returns `400` missing body, `409` stale, `200` success.
- `admin.routes.test.ts` (extended) — `GET`/`POST /api/admin/tos/versions` return `401`/`403`/`200` per the existing admin-route pattern; `POST` with blank content is `400`.
- `challenges.routes.test.ts` / `runs.routes.test.ts` (extended) — an authenticated user with `tosAcceptanceRequired: true` gets `403 tos_required` from a previously-200 endpoint; a user who has accepted passes through unchanged.
- `accept-terms.test.tsx` — redirects to `/dashboard` when acceptance isn't required or no ToS is configured; renders content and disabled button pre-checkbox; submit success navigates to `/dashboard`; `409` shows the re-review message without navigating.
- `admin-tos.test.tsx` — unauthorized non-admin sees "Not authorized."; publish flow clears the textarea and shows the new version as current.

## Open Items for the Implementation Plan

- Exact copy for the re-review message and the "Not authorized." admin screen — cosmetic, pin during implementation.
- Whether `/accept-terms` needs its own `TopBar` (likely a minimal header, no nav links, since the user can't go anywhere else yet) — implementation detail, not a design decision.
