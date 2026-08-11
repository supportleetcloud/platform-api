# Challenge Authoring (Admin) — Design

> `PLANO_MVP.md`'s "Motor de desafios" only describes the YAML grammar and says "5 a 8 challenges escritos pela própria dupla" — it never specifies *how* those challenges get authored. Today they're hand-written YAML files in `backend/challenges/`, loaded by `seed-challenges.ts`. This spec adds a Painel Admin screen to create/edit/archive challenges without touching a YAML file or redeploying, while leaving the existing 8 file-seeded challenges and the Java validation-engine completely untouched. Builds on `requireAdmin` and the existing `Challenge`/`Run` Prisma models. Does **not** cover non-admin (self-serve) challenge submission, external content curation (explicitly out of scope per `PLANO_MVP.md`), or any change to the validation-engine's YAML grammar or HTTP execution.

## Goal

An admin creates, edits, and archives challenges from a form — title, description, objective, technical details, category, and a list of "request types" (HTTP method + request shape + expected response, each worth points) — without writing YAML or redeploying. The existing "take a challenge" flow (catalog → detail page → submit URL → see pass/fail) already exists and is extended only with the new descriptive text fields; its core mechanics are unchanged.

## Scope

In scope:
- `Challenge` gains `description`, `objective`, `technicalDetails` (all optional text) and `archived` (soft-delete flag). `yamlPath` becomes nullable — null means "defined in the database," not "in a file."
- New `ChallengeCheck` table — one row per "request type," structurally mirroring the existing YAML `checks[]` grammar (`request.method/path/headers/body`, `expect.status/json/headers`, `points`), plus an `order` column since check ordering is load-bearing (later checks reference earlier ones via `{{steps[N].response...}}` templating, already supported by the validation-engine).
- `backend/src/challenges/service.ts` gains create/update/archive/list-admin/get-admin functions, plus `buildChallengeYaml` — serializes a DB-defined challenge's checks into the exact YAML text shape the validation-engine already consumes, via `js-yaml.dump` (the same library already used to *parse* file-based challenges).
- New `backend/src/challenges/admin-routes.ts` module: full CRUD for admins (`GET`/`POST /api/admin/challenges`, `GET`/`PUT /api/admin/challenges/:id`, `PUT /api/admin/challenges/:id/archive`).
- `backend/src/runs/service.ts`'s existing YAML-loading step branches: file-seeded challenges (`yamlPath` set) still `fs.readFileSync` exactly as today; DB-defined challenges (`yamlPath` null) call `buildChallengeYaml` instead. The validation-engine receives an identical YAML string either way and cannot tell the difference.
- Existing public `GET /api/challenges` / `GET /api/challenges/:id` (`backend/src/challenges/routes.ts`) filter out archived challenges and the detail route gains the three new text fields.
- Frontend: `/admin/challenges` (list, archive/unarchive), `/admin/challenges/new` and `/admin/challenges/[id]/edit` (a shared `ChallengeForm` component), and the existing `challenges/[id]` take-screen renders the new text fields when present. `TopBar` admin nav gains a link.

Explicitly out of scope: non-admin challenge creation (`PLANO_MVP.md` rules out external curation for v1), any change to `validation-engine`'s Java code or YAML grammar (this feature is designed specifically to need none), editing/retiring the 8 existing file-seeded challenges through this UI (they stay YAML-file-owned; nothing stops an admin from also creating new, unrelated DB-defined challenges alongside them), a "resume/unarchive" prompt or confirmation dialog beyond the button itself, drag-to-reorder checks (order is set by list position at save time), and any rich-text/markdown rendering for description/objective/technicalDetails (plain text, matches `ToS`'s existing precedent of plain `white-space: pre-wrap` content).

## Data Model (additions to `backend/prisma/schema.prisma`)

```prisma
model Challenge {
  id               String   @id @default(uuid())
  title            String
  description      String?  @db.Text
  objective        String?  @db.Text
  technicalDetails String?  @db.Text
  category         String
  points           Int
  yamlPath         String?
  archived         Boolean  @default(false)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  runs   Run[]
  checks ChallengeCheck[]
}

model ChallengeCheck {
  id             String  @id @default(uuid())
  challengeId    String
  name           String
  method         String
  path           String
  requestHeaders Json?
  requestBody    Json?
  expectStatus   Int
  expectJson     Json?
  expectHeaders  Json?
  points         Int
  order          Int

  challenge Challenge @relation(fields: [challengeId], references: [id], onDelete: Cascade)

  @@index([challengeId])
}
```

`Challenge.id` changes from a bare `@id` (previously always the hand-picked slug from a YAML's `id:` field, e.g. `"todo-api-crud"`) to `@id @default(uuid())` — this only supplies a default for *rows that don't specify one*; existing seeded rows keep their existing string primary keys unchanged, and `seedChallengesFromDirectory` continues to pass the YAML's `id` explicitly, bypassing the default exactly as before. `updatedAt` and `archived` are new columns on an existing table (both defaulted/nullable-safe, no backfill needed). `yamlPath` drops its implicit non-null requirement — existing rows already have a value, so no migration-time backfill is needed; only new DB-defined challenges will ever have it null.

`onDelete: Cascade` on `ChallengeCheck.challengeId` — a `Challenge` row is never actually SQL-deleted by this feature (archive is a flag, not a `DELETE`), so this cascade is dead code for the flows this spec builds, but it's the correct safety net if a challenge row is ever removed by some other means (e.g. a future admin hard-delete, or manual cleanup) — it prevents orphaned check rows rather than leaving that failure mode unhandled.

## Score Computation

`Challenge.points` is the sum of its `ChallengeCheck.points` — computed at create/update time (not derived at read time), matching how `seedChallengesFromDirectory` already computes it via the existing `sumPoints` helper for file-based challenges. `sumPoints(checks: { points: number }[])` is generic enough to reuse as-is for `ChallengeCheckInput[]` without modification.

## Backend

### `backend/src/challenges/service.ts` (extended)

```ts
const KNOWN_CATEGORIES = ['crud', 'contract', 'status', 'auth']

export type ChallengeCheckInput = {
  name: string
  method: string
  path: string
  requestHeaders?: Record<string, string>
  requestBody?: unknown
  expectStatus: number
  expectJson?: unknown
  expectHeaders?: Record<string, string>
  points: number
}

export type ChallengeInput = {
  title: string
  description?: string
  objective?: string
  technicalDetails?: string
  category: string
  checks: ChallengeCheckInput[]
}

export type SaveChallengeResult =
  | { kind: 'saved'; challengeId: string }
  | { kind: 'validation_error'; error: string }

export async function createChallenge(prisma: PrismaClient, input: ChallengeInput): Promise<SaveChallengeResult>
export async function updateChallenge(prisma: PrismaClient, id: string, input: ChallengeInput): Promise<SaveChallengeResult>

export type SetArchivedResult = { kind: 'updated' } | { kind: 'not_found' }
export async function setChallengeArchived(prisma: PrismaClient, id: string, archived: boolean): Promise<SetArchivedResult>

export type AdminChallengeListItem = {
  id: string
  title: string
  category: string
  points: number
  archived: boolean
  source: 'file' | 'database'
}
export async function listAdminChallenges(prisma: PrismaClient): Promise<AdminChallengeListItem[]>

export type AdminChallengeDetail = ChallengeInput & { id: string; archived: boolean; source: 'file' | 'database' }
export async function getAdminChallenge(prisma: PrismaClient, id: string): Promise<AdminChallengeDetail | null>

export function buildChallengeYaml(
  challenge: { id: string; title: string; category: string },
  checks: { name: string; method: string; path: string; requestHeaders: unknown; requestBody: unknown; expectStatus: number; expectJson: unknown; expectHeaders: unknown; points: number }[]
): string
```

- **Validation** (shared by `createChallenge`/`updateChallenge`): `title` non-empty; `category` must be one of `KNOWN_CATEGORIES`; `checks.length >= 1`; each check requires non-empty `name`/`method`/`path` (`path` must start with `/`), `expectStatus` an integer in `[100, 599]`, and `points` a positive integer. First violation found short-circuits with `validation_error` and a specific message (matching the existing per-field-message convention in `tos/service.ts`/`llm/settings.ts`), not a generic "invalid input."
- **`createChallenge`** — computes `points` via `sumPoints`, creates the `Challenge` row with `yamlPath: null`, and creates its `ChallengeCheck` rows in the same transaction (`prisma.$transaction`), each stamped with `order` from its position in the input array.
- **`updateChallenge`** — recomputes `points`, updates the `Challenge` row's fields, and replaces the entire `ChallengeCheck` set for that challenge (delete-then-recreate inside a transaction, rather than diffing individual rows — simpler, and `order`/`id` stability across edits has no consumer that needs it: nothing references a `ChallengeCheck.id` externally, and a `Run`'s own `checks` JSON column already stores its *result* snapshot independent of the definition). Rejects with `not_found`-equivalent (the route returns 404) if the `Challenge` row doesn't exist or is file-seeded (`yamlPath` not null) — **editing a file-seeded challenge through this API is not supported**, since its source of truth is the YAML file, not these rows; the route surfaces this as `400 { error: 'challenge is file-defined, not editable' }` to disambiguate from a genuine 404.
- **`setChallengeArchived`** — `updateMany`-style existence check then a plain field update; works for both file-seeded and DB-defined challenges (archiving a file-seeded challenge is a legitimate way to retire it from the catalog without deleting its YAML file or its historical `Run`s).
- **`listAdminChallenges`** — all challenges including archived, `source` derived as `challenge.yamlPath ? 'file' : 'database'` so the admin list can visually distinguish (and the frontend can disable the "Edit" link for file-sourced rows, matching the `updateChallenge` restriction above).
- **`buildChallengeYaml`** — pure function, no I/O. Produces the same shape `parseChallengeYaml` already reads:
  ```yaml
  id: <challenge.id>
  title: <title>
  category: <category>
  checks:
    - name: ...
      request:
        method: ...
        path: ...
        headers: {...}     # omitted entirely if requestHeaders is null/undefined
        body: {...}        # omitted entirely if requestBody is null/undefined
      expect:
        status: ...
        json: {...}        # omitted entirely if expectJson is null/undefined
        headers: {...}     # omitted entirely if expectHeaders is null/undefined
      points: ...
  ```
  via `yaml.dump({ id: challenge.id, title: challenge.title, category: challenge.category, checks: checks.map(...) })`, with checks passed in already sorted by `order` (the caller's responsibility — `runs/service.ts` queries with `orderBy: { order: 'asc' }`).

### `backend/src/challenges/admin-routes.ts` (new module)

A separate file from the existing `backend/src/admin/routes.ts` — that file already threads a `stripe: Stripe` dependency through for the billing/tos/llm-settings routes it owns, none of which this feature needs; keeping challenge CRUD in its own module avoids growing an unrelated file and avoids handing this module a Stripe client it has no use for.

```ts
export function createChallengesAdminRouter(prisma: PrismaClient): Router
```

Routes, all `requireAuth, requireAdmin`:
- `GET /api/admin/challenges` → `200 AdminChallengeListItem[]`.
- `GET /api/admin/challenges/:id` → `200 AdminChallengeDetail`, or `404 { error: 'challenge_not_found' }`.
- `POST /api/admin/challenges` → body is `ChallengeInput`; `201` with `{ challengeId }` on success, `400 { error }` on `validation_error`.
- `PUT /api/admin/challenges/:id` → body is `ChallengeInput`; `200 { challengeId }` on success, `400 { error }` on `validation_error` (including the file-seeded-not-editable case), `404` if the challenge doesn't exist at all.
- `PUT /api/admin/challenges/:id/archive` → body `{ archived: boolean }`; `200 { archived }` on success, `404` if not found, `400` if `archived` isn't a boolean.

Follows the existing per-route try/catch + `500 { error: 'message' }` convention (matching `ranking/routes.ts` and the already-hardened `admin/routes.ts` billing routes — not the older pattern some earlier routes shipped without it).

### `backend/src/challenges/routes.ts` (existing, modified)

- `GET /api/challenges` — `where: { archived: false }` added to the existing query; `select` unchanged (dashboard's catalog card only ever showed `id/title/category/points`).
- `GET /api/challenges/:id` — `where: { id, archived: false }` (via `findFirst`, since `findUnique` can't combine a non-unique filter with the id lookup); `select` gains `description`, `objective`, `technicalDetails`. An archived challenge 404s here exactly like a nonexistent one — no distinct "this exists but is archived" signal, matching the existing `hideFromRanking` precedent of never leaking removed/hidden state.

### `backend/src/runs/service.ts` (existing, modified)

Two changes to `submitRun`:

1. The challenge lookup changes from `prisma.challenge.findUnique({ where: { id: input.challengeId } })` to `prisma.challenge.findFirst({ where: { id: input.challengeId, archived: false } })` — an archived challenge is treated identically to a nonexistent one (`validation_error: 'challenge not found'`), blocking new submissions without touching anyone's existing `Run` history.
2. The YAML-loading step:
   ```ts
   let challengeYaml: string
   if (challenge.yamlPath) {
     try {
       challengeYaml = fs.readFileSync(path.join(CHALLENGES_DIR, challenge.yamlPath), 'utf-8')
     } catch (err) {
       console.error(`Failed to read challenge YAML for ${challenge.id} at ${challenge.yamlPath}:`, err)
       return { kind: 'internal_error', error: 'failed to load challenge definition' }
     }
   } else {
     const checks = await prisma.challengeCheck.findMany({
       where: { challengeId: challenge.id },
       orderBy: { order: 'asc' },
     })
     if (checks.length === 0) {
       console.error(`DB-defined challenge ${challenge.id} has no checks`)
       return { kind: 'internal_error', error: 'failed to load challenge definition' }
     }
     challengeYaml = buildChallengeYaml(challenge, checks)
   }
   ```
   The zero-checks guard is defensive — `createChallenge`/`updateChallenge`'s own validation already requires `checks.length >= 1`, so this path should be unreachable in practice, but `submitRun` has no other way to fail closed if it somehow is (e.g. a future direct DB edit).

Everything downstream of `challengeYaml` (the HTTP call to the validation-engine, webhook handling, `Run` creation) is completely unchanged — the validation-engine receives a YAML string exactly like it always has and has no way to know whether it came from a file or a database row.

## Frontend

**`frontend/app/admin/challenges/page.tsx`** (new): `useResource<AdminChallengeListItem[]>('/api/admin/challenges')`. Table columns: title, category badge, points, an "archived" badge when `archived: true`. "New Challenge" button → `/admin/challenges/new`. Per row: "Edit" link → `/admin/challenges/[id]/edit` (disabled/omitted when `source === 'file'`, per the backend's edit restriction above — file-seeded challenges show a "file-defined" note instead), and an Archive/Unarchive button → `PUT /api/admin/challenges/:id/archive` with an inline optimistic toggle (same pattern as the dashboard's `hideFromRanking` checkbox).

**`frontend/app/admin/challenges/ChallengeForm.tsx`** (new, shared component — not a route): the actual form, parameterized by an `onSave(input: ChallengeInput) => Promise<{ ok: true } | { ok: false; error: string }>` callback and an optional `initial: ChallengeInput` (present for edit, absent for create).
- Fields: title, description (textarea), objective (textarea), technical details (textarea), category (`<select>` of the 4 known values).
- A dynamic list of check rows (local component state, an array), each row: name, method (`<select>` GET/POST/PUT/DELETE/QUERY), path, request headers (optional JSON textarea), request body (optional JSON textarea), expected status (number input), expected response JSON (optional JSON textarea), expected headers (optional JSON textarea), points (number input). "Add request type" / per-row "Remove" buttons.
- JSON textareas hold raw text in local state (no per-keystroke parsing); `JSON.parse` runs only on submit, per field, per row. An empty/whitespace-only textarea means "omit this optional field" (`undefined`), not an error. A parse failure sets an inline error on that specific row/field and blocks submission — no network call is made with malformed JSON.
- No new form-handling dependency — matches every existing form in this codebase (plain `useState` + manual validation, no `react-hook-form`/`zod`/etc. anywhere in `frontend/`).
- Submit calls `onSave`, shows its error inline on failure, and lets the caller (the `new`/`edit` page) handle success navigation — the form component itself doesn't know or care whether it's creating or editing.

**`frontend/app/admin/challenges/new/page.tsx`** (new): admin-guard (`useResource<Me>` + `isAdmin` check, same shape as `admin/llm-settings`), renders `<ChallengeForm>` with no `initial`, `onSave` does `POST /api/admin/challenges`, navigates to `/admin/challenges` on success.

**`frontend/app/admin/challenges/[id]/edit/page.tsx`** (new): admin-guard, `useResource<AdminChallengeDetail>('/api/admin/challenges/:id')`, renders `<ChallengeForm initial={...}>`, `onSave` does `PUT /api/admin/challenges/:id`, navigates to `/admin/challenges` on success. If `source === 'file'` (reachable only by navigating here directly for a file-sourced id, since the list page already omits its Edit link), renders a "This challenge is defined in a YAML file and can't be edited here." message instead of the form — the backend's `400` on a PUT against a file-seeded challenge is defense-in-depth against that direct-navigation path, not the primary UX signal.

**`frontend/app/challenges/[id]/page.tsx`** (existing, modified): the `ChallengeDetail` type gains `description`, `objective`, `technicalDetails` (all `string | null`); each renders as its own labeled section above the existing URL-submission form only when non-null/non-empty — a file-seeded challenge without these fields (all 8 existing ones, until an admin fills them in via the edit screen) renders exactly as it does today, no empty headings.

**`TopBar.tsx`**: one new admin-nav link, `<a href="/admin/challenges">Challenges</a>`, alongside the existing `LLM`/`ToS`/`Billing` links.

## Error Handling

Follows the existing per-route try/catch + `{ error: "message" }` pattern throughout — no new global error middleware, no new error class hierarchy. `createChallenge`/`updateChallenge`'s validation failures are expected, user-facing outcomes (`400`, not `500`), matching every other `validation_error`-kind service function in this codebase.

## Testing Strategy

Mirrors the existing suite shape (Jest + Supertest against a real Postgres test database; Vitest + Testing Library on the frontend):

- `challenges.service.test.ts` (extended) — `createChallenge`/`updateChallenge` reject each invalid-input case (blank title, unknown category, zero checks, bad `path`, non-integer `expectStatus`, non-positive `points`) with the specific message; `points` is correctly summed; `updateChallenge` replaces the check set (old rows gone, new rows present) and rejects a file-seeded challenge id; `setChallengeArchived` toggles and returns `not_found` for a bogus id; `buildChallengeYaml` output round-trips through the existing `parseChallengeYaml` and produces the exact shape a hand-written YAML file would (optional fields correctly omitted when absent, present when set).
- `challenges.admin.routes.test.ts` (new) — full CRUD lifecycle through the real HTTP layer: `401`/`403` on every route for unauthenticated/non-admin; create → 201 → appears in the list; get returns full detail with checks; update on a DB-defined challenge succeeds and old checks are gone; update on a file-seeded challenge (a real seeded fixture challenge, or a `Challenge` row created directly with a non-null `yamlPath`) returns `400`; archive toggles `archived` and the challenge disappears from the public `/api/challenges` list (cross-checks against the existing `challenges.routes.test.ts` fixtures).
- `runs.e2e.test.ts` (extended) — a full pending→completed run against a DB-defined challenge (no `yamlPath`, `ChallengeCheck` rows created directly via Prisma in the test) asserts the mocked validation-engine call received a `challengeYaml` string that, when parsed back with `js-yaml`, matches the checks that were seeded — proving the DB→YAML round trip end-to-end, not just `buildChallengeYaml`'s output in isolation. Also: submitting against an archived challenge returns the same `free_tier_limit`-style `validation_error` a nonexistent challenge id would.
- `admin-challenges-list.test.tsx` (new) — renders the table from a mocked fetch; archive button calls the archive endpoint and updates the row optimistically; Edit link is present for `source: 'database'` rows and absent (or shows a note) for `source: 'file'` rows.
- `admin-challenge-form.test.tsx` (new, tests the shared component directly, not through a page) — adding/removing check rows updates the submitted payload; an invalid JSON textarea blocks submit and shows an inline error without firing a network call; a valid submission calls `onSave` with the exact expected `ChallengeInput` shape (including that empty optional JSON fields become `undefined`, not empty strings).
- `admin-challenges-new.test.tsx` / `admin-challenges-edit.test.tsx` (new, thin — mostly wiring) — non-admin sees "Not authorized."; edit page pre-fills the form from the fetched detail; successful save navigates to `/admin/challenges`.
- `challenges-detail.test.tsx` (extended) — renders `description`/`objective`/`technicalDetails` sections when present in the mocked response; renders none of them (no empty headings) when all three are null, covering the existing 8 file-seeded challenges' current shape.

## Open Items for the Implementation Plan

- Exact table/form layout and copy (button labels, section headings) — cosmetic, pin during implementation.
- Whether `ChallengeForm`'s check-row JSON textareas get any placeholder/example text to guide an admin unfamiliar with the grammar (e.g. a hint showing `{{steps[0].response.json.id}}` templating) — a UX nicety, not a design decision, and not required for the feature to function.
- Whether the admin list's "file-defined, not editable" note should link to the actual YAML file's repo path for a developer who *can* edit it — implementation detail, low priority given this is an internal admin-only screen for a two-person team who already know where the files live.
