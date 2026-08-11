# Challenge Authoring (Admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin creates, edits, and archives challenges from a form — title, description, objective, technical details, category, and a list of request types (method/request/expected response, each worth points) — without writing YAML or redeploying. The existing take-a-challenge flow is extended only with the new descriptive text fields.

**Architecture:** New `ChallengeCheck` table mirrors the existing YAML `checks[]` grammar exactly. Admin-created challenges have `yamlPath: null`; at run-submission time, `runs/service.ts` branches — file-seeded challenges still `fs.readFileSync` as today, DB-defined ones get their checks serialized into an identical YAML string via a new `buildChallengeYaml` (`js-yaml.dump`, the same library already used to *parse* file-based challenges). The validation-engine (Java) receives the same wire format either way and is not modified.

**Tech Stack:** Node.js + TypeScript, Express, Prisma (Postgres), Jest + Supertest (backend); Next.js + Vitest + Testing Library (frontend) — all existing conventions, no new dependencies.

## Global Constraints

- `category` must be one of `crud`, `contract`, `status`, `auth` — validated in the service layer, no Prisma enum (matches the existing freeform-but-conventional `Challenge.category` column).
- File-seeded challenges (`yamlPath` not null) are **read-only** through the admin API — `updateChallenge` rejects with a distinct `file_defined` result (routed to `400`), never editable via this UI (design spec, "Backend").
- Archived challenges are excluded from the public catalog (`GET /api/challenges`, `GET /api/challenges/:id`) and from new run submissions (`runs/service.ts`'s challenge lookup) — always treated identically to a nonexistent challenge, no distinct "exists but archived" signal ever leaks (design spec, "Backend" — matches the `hideFromRanking` precedent).
- `ChallengeCheck.order` is load-bearing: checks reference earlier ones via `{{steps[N].response...}}` templating (already supported by the validation-engine), so `buildChallengeYaml` must emit them in `order` order, and `updateChallenge` must re-stamp `order` from the submitted array's position every time (delete-then-recreate, not a diff).
- No new frontend form-handling dependency — plain `useState` + manual validation, matching every existing form in this codebase (no `react-hook-form`/`zod`/etc. anywhere in `frontend/`).
- `Challenge.id` changes from a bare `@id` to `@id @default(uuid())` — existing seeded rows keep their hand-picked string ids unchanged; `seedChallengesFromDirectory` continues to pass the YAML's `id` explicitly, bypassing the default exactly as before.
- `Challenge.points` is always the sum of its checks' `points`, recomputed on every create/update via the existing `sumPoints` helper — never set directly by the client.
- Code style matches the existing codebase exactly: no semicolons, single quotes, 2-space indent (both `backend/` and `frontend/`); dependencies injected via factory functions (`createXRouter(prisma, ...)`); backend tests run against a real Postgres test database via Prisma; frontend tests mock `global.fetch` and `next/navigation`.
- Every test that creates `Challenge`/`ChallengeCheck` rows scopes its cleanup to its own ids — `Challenge` is shared by many other test files across the suite (never a bare `deleteMany({})` on it).

---

## Task 1: Data model — `Challenge` fields + `ChallengeCheck`

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `Challenge.description/objective/technicalDetails: string | null`, `Challenge.archived: boolean`, `Challenge.updatedAt: DateTime`, `Challenge.yamlPath: string | null` (now nullable), `Challenge.id` default-generated when omitted; `ChallengeCheck` model — used by every later task.

- [ ] **Step 1: Modify the `Challenge` model and add `ChallengeCheck`**

In `backend/prisma/schema.prisma`, replace the existing `Challenge` model:

```prisma
model Challenge {
  id        String   @id
  title     String
  // Freeform, matches whatever the YAML's top-level `category:` field says
  // (crud, contract, status, auth in the fixtures below) — no enum enforced.
  category  String
  points    Int
  yamlPath  String
  createdAt DateTime @default(now())

  runs Run[]
}
```

with:

```prisma
model Challenge {
  id               String   @id @default(uuid())
  title            String
  description      String?  @db.Text
  objective        String?  @db.Text
  technicalDetails String?  @db.Text
  // Freeform, matches whatever the YAML's top-level `category:` field says
  // (crud, contract, status, auth in the fixtures below) — no enum enforced.
  category         String
  points           Int
  // Null means this challenge is defined in the database (ChallengeCheck rows below),
  // not a file under backend/challenges/ — see runs/service.ts's YAML-loading branch.
  yamlPath         String?
  archived         Boolean  @default(false)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  runs   Run[]
  checks ChallengeCheck[]
}
```

Add a new model at the end of the file:

```prisma
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

- [ ] **Step 2: Migrate**

Run:
```bash
cd backend && npx prisma migrate dev --name add_challenge_authoring
```
Expected: a new folder under `backend/prisma/migrations/`, no drift warning.

Apply to the test database too:
```bash
DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npx prisma migrate deploy
```

- [ ] **Step 3: Confirm the existing suite still passes**

Run: `cd backend && npm test`
Expected: all existing tests green — the new columns are nullable/defaulted and the new table is unused so far; the 8 file-seeded challenges are untouched.

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "feat: add Challenge description/objective/archived fields and ChallengeCheck model"
```

---

## Task 2: `challenges/service.ts` — admin CRUD + YAML serialization

**Files:**
- Modify: `backend/src/challenges/service.ts`
- Test: `backend/tests/challenges.service.test.ts` (extended)

**Interfaces:**
- Consumes: `Challenge`/`ChallengeCheck` (Task 1); existing `sumPoints`, `CHALLENGES_DIR`, `js-yaml` import already in this file.
- Produces (used by Tasks 3 and 5):
  - `ChallengeCheckInput`, `ChallengeInput` types.
  - `SaveChallengeResult = { kind: 'saved'; challengeId: string } | { kind: 'validation_error'; error: string } | { kind: 'not_found' } | { kind: 'file_defined' }`
  - `createChallenge(prisma, input: ChallengeInput): Promise<SaveChallengeResult>`
  - `updateChallenge(prisma, id: string, input: ChallengeInput): Promise<SaveChallengeResult>`
  - `SetArchivedResult = { kind: 'updated' } | { kind: 'not_found' }`
  - `setChallengeArchived(prisma, id: string, archived: boolean): Promise<SetArchivedResult>`
  - `AdminChallengeListItem`, `listAdminChallenges(prisma): Promise<AdminChallengeListItem[]>`
  - `AdminChallengeDetail`, `getAdminChallenge(prisma, id: string): Promise<AdminChallengeDetail | null>`
  - `buildChallengeYaml(challenge, checks): string`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/challenges.service.test.ts` (add these imports to the existing `import { ... } from '../src/challenges/service'` block: `createChallenge, updateChallenge, setChallengeArchived, listAdminChallenges, getAdminChallenge, buildChallengeYaml`), then add new `describe` blocks at the end of the file:

```ts
describe('admin challenge CRUD', () => {
  afterEach(async () => {
    await prisma.challengeCheck.deleteMany({ where: { challenge: { title: { startsWith: 'Admin CRUD Test' } } } })
    await prisma.challenge.deleteMany({ where: { title: { startsWith: 'Admin CRUD Test' } } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  const VALID_INPUT = {
    title: 'Admin CRUD Test Challenge',
    description: 'A test challenge',
    objective: 'Prove the CRUD works',
    technicalDetails: 'Uses a fake API',
    category: 'crud',
    checks: [
      {
        name: 'GET /ping',
        method: 'GET',
        path: '/ping',
        expectStatus: 200,
        points: 10,
      },
      {
        name: 'POST /echo',
        method: 'POST',
        path: '/echo',
        requestBody: { hello: 'world' },
        expectStatus: 201,
        expectJson: { hello: 'world' },
        expectHeaders: { 'Content-Type': 'application/json' },
        points: 15,
      },
    ],
  }

  describe('createChallenge', () => {
    it('rejects a blank title', async () => {
      const result = await createChallenge(prisma, { ...VALID_INPUT, title: '' })
      expect(result).toEqual({ kind: 'validation_error', error: 'title is required' })
    })

    it('rejects an unknown category', async () => {
      const result = await createChallenge(prisma, { ...VALID_INPUT, category: 'bogus' })
      expect(result.kind).toBe('validation_error')
      if (result.kind === 'validation_error') {
        expect(result.error).toContain('category must be one of')
      }
    })

    it('rejects zero checks', async () => {
      const result = await createChallenge(prisma, { ...VALID_INPUT, checks: [] })
      expect(result).toEqual({ kind: 'validation_error', error: 'at least one request type is required' })
    })

    it('rejects a check with a path that does not start with /', async () => {
      const result = await createChallenge(prisma, {
        ...VALID_INPUT,
        checks: [{ ...VALID_INPUT.checks[0], path: 'ping' }],
      })
      expect(result.kind).toBe('validation_error')
      if (result.kind === 'validation_error') {
        expect(result.error).toBe('check 1: path must start with /')
      }
    })

    it('rejects a check with a non-positive points value', async () => {
      const result = await createChallenge(prisma, {
        ...VALID_INPUT,
        checks: [{ ...VALID_INPUT.checks[0], points: 0 }],
      })
      expect(result.kind).toBe('validation_error')
      if (result.kind === 'validation_error') {
        expect(result.error).toBe('check 1: points must be a positive integer')
      }
    })

    it('creates the challenge, sums points, and creates ordered checks', async () => {
      const result = await createChallenge(prisma, VALID_INPUT)
      expect(result.kind).toBe('saved')
      if (result.kind !== 'saved') return

      const challenge = await prisma.challenge.findUnique({ where: { id: result.challengeId } })
      expect(challenge?.points).toBe(25)
      expect(challenge?.yamlPath).toBeNull()
      expect(challenge?.archived).toBe(false)

      const checks = await prisma.challengeCheck.findMany({
        where: { challengeId: result.challengeId },
        orderBy: { order: 'asc' },
      })
      expect(checks).toHaveLength(2)
      expect(checks[0].name).toBe('GET /ping')
      expect(checks[0].order).toBe(0)
      expect(checks[1].name).toBe('POST /echo')
      expect(checks[1].order).toBe(1)
      expect(checks[1].requestBody).toEqual({ hello: 'world' })
    })
  })

  describe('updateChallenge', () => {
    it('returns not_found for a nonexistent id', async () => {
      const result = await updateChallenge(prisma, 'admin-crud-test-does-not-exist', VALID_INPUT)
      expect(result).toEqual({ kind: 'not_found' })
    })

    it('returns file_defined for a file-seeded challenge', async () => {
      const fileChallenge = await prisma.challenge.create({
        data: { title: 'Admin CRUD Test File Challenge', category: 'crud', points: 10, yamlPath: 'todo-api-crud.yaml' },
      })
      const result = await updateChallenge(prisma, fileChallenge.id, VALID_INPUT)
      expect(result).toEqual({ kind: 'file_defined' })
    })

    it('replaces the check set and recomputes points', async () => {
      const created = await createChallenge(prisma, VALID_INPUT)
      if (created.kind !== 'saved') throw new Error('setup failed')

      const result = await updateChallenge(prisma, created.challengeId, {
        ...VALID_INPUT,
        title: 'Admin CRUD Test Challenge (updated)',
        checks: [{ name: 'DELETE /reset', method: 'DELETE', path: '/reset', expectStatus: 204, points: 5 }],
      })
      expect(result).toEqual({ kind: 'saved', challengeId: created.challengeId })

      const challenge = await prisma.challenge.findUnique({ where: { id: created.challengeId } })
      expect(challenge?.title).toBe('Admin CRUD Test Challenge (updated)')
      expect(challenge?.points).toBe(5)

      const checks = await prisma.challengeCheck.findMany({ where: { challengeId: created.challengeId } })
      expect(checks).toHaveLength(1)
      expect(checks[0].name).toBe('DELETE /reset')
    })
  })

  describe('setChallengeArchived', () => {
    it('returns not_found for a nonexistent id', async () => {
      const result = await setChallengeArchived(prisma, 'admin-crud-test-does-not-exist', true)
      expect(result).toEqual({ kind: 'not_found' })
    })

    it('toggles archived', async () => {
      const created = await createChallenge(prisma, VALID_INPUT)
      if (created.kind !== 'saved') throw new Error('setup failed')

      expect(await setChallengeArchived(prisma, created.challengeId, true)).toEqual({ kind: 'updated' })
      let challenge = await prisma.challenge.findUnique({ where: { id: created.challengeId } })
      expect(challenge?.archived).toBe(true)

      expect(await setChallengeArchived(prisma, created.challengeId, false)).toEqual({ kind: 'updated' })
      challenge = await prisma.challenge.findUnique({ where: { id: created.challengeId } })
      expect(challenge?.archived).toBe(false)
    })
  })

  describe('listAdminChallenges / getAdminChallenge', () => {
    it('lists both file-seeded and database-defined challenges, labeling their source', async () => {
      const fileChallenge = await prisma.challenge.create({
        data: { title: 'Admin CRUD Test File Challenge', category: 'crud', points: 10, yamlPath: 'todo-api-crud.yaml' },
      })
      const created = await createChallenge(prisma, VALID_INPUT)
      if (created.kind !== 'saved') throw new Error('setup failed')

      const list = await listAdminChallenges(prisma)
      const fileEntry = list.find((c) => c.id === fileChallenge.id)
      const dbEntry = list.find((c) => c.id === created.challengeId)
      expect(fileEntry?.source).toBe('file')
      expect(dbEntry?.source).toBe('database')
    })

    it('getAdminChallenge returns full detail with ordered checks, or null', async () => {
      expect(await getAdminChallenge(prisma, 'admin-crud-test-does-not-exist')).toBeNull()

      const created = await createChallenge(prisma, VALID_INPUT)
      if (created.kind !== 'saved') throw new Error('setup failed')

      const detail = await getAdminChallenge(prisma, created.challengeId)
      expect(detail?.title).toBe('Admin CRUD Test Challenge')
      expect(detail?.source).toBe('database')
      expect(detail?.checks).toHaveLength(2)
      expect(detail?.checks[0].name).toBe('GET /ping')
      expect(detail?.checks[1].requestBody).toEqual({ hello: 'world' })
    })
  })
})

describe('buildChallengeYaml', () => {
  it('produces YAML that parses back to the same shape via parseChallengeYaml', () => {
    const yamlText = buildChallengeYaml(
      { id: 'yaml-build-test', title: 'YAML Build Test', category: 'crud' },
      [
        {
          name: 'GET /ping',
          method: 'GET',
          path: '/ping',
          requestHeaders: null,
          requestBody: null,
          expectStatus: 200,
          expectJson: null,
          expectHeaders: null,
          points: 10,
        },
        {
          name: 'POST /echo',
          method: 'POST',
          path: '/echo',
          requestHeaders: { 'X-Test': 'yes' },
          requestBody: { hello: 'world' },
          expectStatus: 201,
          expectJson: { hello: 'world' },
          expectHeaders: null,
          points: 15,
        },
      ]
    )

    const parsed = parseChallengeYaml(yamlText)
    expect(parsed.id).toBe('yaml-build-test')
    expect(parsed.title).toBe('YAML Build Test')
    expect(parsed.category).toBe('crud')
    expect(sumPoints(parsed.checks)).toBe(25)

    // Optional fields: omitted entirely when null, present when set — parse the raw YAML
    // object (not just the ChallengeCheckSpec-typed view) to check the exact shape.
    const raw = yaml.load(yamlText) as any
    expect(raw.checks[0].request).toEqual({ method: 'GET', path: '/ping' })
    expect(raw.checks[0].request.headers).toBeUndefined()
    expect(raw.checks[0].request.body).toBeUndefined()
    expect(raw.checks[1].request.headers).toEqual({ 'X-Test': 'yes' })
    expect(raw.checks[1].expect.json).toEqual({ hello: 'world' })
  })
})
```

Add `import * as yaml from 'js-yaml'` to the top of the test file (needed for the raw-shape assertions above).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest tests/challenges.service.test.ts`
Expected: FAIL — `createChallenge`, `updateChallenge`, etc. don't exist yet.

- [ ] **Step 3: Implement**

Add to `backend/src/challenges/service.ts` (below the existing `seedChallengesFromDirectory`):

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

function validateChallengeInput(input: ChallengeInput): string | null {
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    return 'title is required'
  }
  if (!KNOWN_CATEGORIES.includes(input.category)) {
    return `category must be one of: ${KNOWN_CATEGORIES.join(', ')}`
  }
  if (!Array.isArray(input.checks) || input.checks.length === 0) {
    return 'at least one request type is required'
  }
  for (let i = 0; i < input.checks.length; i++) {
    const check = input.checks[i]
    const label = `check ${i + 1}`
    if (typeof check.name !== 'string' || check.name.trim().length === 0) {
      return `${label}: name is required`
    }
    if (typeof check.method !== 'string' || check.method.trim().length === 0) {
      return `${label}: method is required`
    }
    if (typeof check.path !== 'string' || !check.path.startsWith('/')) {
      return `${label}: path must start with /`
    }
    if (!Number.isInteger(check.expectStatus) || check.expectStatus < 100 || check.expectStatus > 599) {
      return `${label}: expectStatus must be an integer between 100 and 599`
    }
    if (!Number.isInteger(check.points) || check.points <= 0) {
      return `${label}: points must be a positive integer`
    }
  }
  return null
}

function checkCreateData(challengeId: string, checks: ChallengeCheckInput[]) {
  return checks.map((check, index) => ({
    challengeId,
    name: check.name,
    method: check.method,
    path: check.path,
    requestHeaders: check.requestHeaders ?? undefined,
    requestBody: check.requestBody ?? undefined,
    expectStatus: check.expectStatus,
    expectJson: check.expectJson ?? undefined,
    expectHeaders: check.expectHeaders ?? undefined,
    points: check.points,
    order: index,
  }))
}

export type SaveChallengeResult =
  | { kind: 'saved'; challengeId: string }
  | { kind: 'validation_error'; error: string }
  | { kind: 'not_found' }
  | { kind: 'file_defined' }

export async function createChallenge(prisma: PrismaClient, input: ChallengeInput): Promise<SaveChallengeResult> {
  const validationError = validateChallengeInput(input)
  if (validationError) {
    return { kind: 'validation_error', error: validationError }
  }

  const points = sumPoints(input.checks)
  const challenge = await prisma.$transaction(async (tx) => {
    const created = await tx.challenge.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        objective: input.objective ?? null,
        technicalDetails: input.technicalDetails ?? null,
        category: input.category,
        points,
        yamlPath: null,
      },
    })
    await tx.challengeCheck.createMany({ data: checkCreateData(created.id, input.checks) })
    return created
  })

  return { kind: 'saved', challengeId: challenge.id }
}

export async function updateChallenge(
  prisma: PrismaClient,
  id: string,
  input: ChallengeInput
): Promise<SaveChallengeResult> {
  const existing = await prisma.challenge.findUnique({ where: { id } })
  if (!existing) {
    return { kind: 'not_found' }
  }
  if (existing.yamlPath) {
    return { kind: 'file_defined' }
  }

  const validationError = validateChallengeInput(input)
  if (validationError) {
    return { kind: 'validation_error', error: validationError }
  }

  const points = sumPoints(input.checks)
  await prisma.$transaction(async (tx) => {
    await tx.challenge.update({
      where: { id },
      data: {
        title: input.title,
        description: input.description ?? null,
        objective: input.objective ?? null,
        technicalDetails: input.technicalDetails ?? null,
        category: input.category,
        points,
      },
    })
    await tx.challengeCheck.deleteMany({ where: { challengeId: id } })
    await tx.challengeCheck.createMany({ data: checkCreateData(id, input.checks) })
  })

  return { kind: 'saved', challengeId: id }
}

export type SetArchivedResult = { kind: 'updated' } | { kind: 'not_found' }

export async function setChallengeArchived(
  prisma: PrismaClient,
  id: string,
  archived: boolean
): Promise<SetArchivedResult> {
  const existing = await prisma.challenge.findUnique({ where: { id } })
  if (!existing) {
    return { kind: 'not_found' }
  }
  await prisma.challenge.update({ where: { id }, data: { archived } })
  return { kind: 'updated' }
}

export type AdminChallengeListItem = {
  id: string
  title: string
  category: string
  points: number
  archived: boolean
  source: 'file' | 'database'
}

export async function listAdminChallenges(prisma: PrismaClient): Promise<AdminChallengeListItem[]> {
  const challenges = await prisma.challenge.findMany({ orderBy: { createdAt: 'asc' } })
  return challenges.map((c) => ({
    id: c.id,
    title: c.title,
    category: c.category,
    points: c.points,
    archived: c.archived,
    source: c.yamlPath ? 'file' : 'database',
  }))
}

export type AdminChallengeDetail = ChallengeInput & {
  id: string
  archived: boolean
  source: 'file' | 'database'
}

export async function getAdminChallenge(prisma: PrismaClient, id: string): Promise<AdminChallengeDetail | null> {
  const challenge = await prisma.challenge.findUnique({
    where: { id },
    include: { checks: { orderBy: { order: 'asc' } } },
  })
  if (!challenge) return null

  return {
    id: challenge.id,
    title: challenge.title,
    description: challenge.description ?? undefined,
    objective: challenge.objective ?? undefined,
    technicalDetails: challenge.technicalDetails ?? undefined,
    category: challenge.category,
    archived: challenge.archived,
    source: challenge.yamlPath ? 'file' : 'database',
    checks: challenge.checks.map((c) => ({
      name: c.name,
      method: c.method,
      path: c.path,
      requestHeaders: (c.requestHeaders as Record<string, string> | null) ?? undefined,
      requestBody: c.requestBody ?? undefined,
      expectStatus: c.expectStatus,
      expectJson: c.expectJson ?? undefined,
      expectHeaders: (c.expectHeaders as Record<string, string> | null) ?? undefined,
      points: c.points,
    })),
  }
}

export function buildChallengeYaml(
  challenge: { id: string; title: string; category: string },
  checks: {
    name: string
    method: string
    path: string
    requestHeaders: unknown
    requestBody: unknown
    expectStatus: number
    expectJson: unknown
    expectHeaders: unknown
    points: number
  }[]
): string {
  return yaml.dump({
    id: challenge.id,
    title: challenge.title,
    category: challenge.category,
    checks: checks.map((check) => ({
      name: check.name,
      request: {
        method: check.method,
        path: check.path,
        ...(check.requestHeaders != null ? { headers: check.requestHeaders } : {}),
        ...(check.requestBody != null ? { body: check.requestBody } : {}),
      },
      expect: {
        status: check.expectStatus,
        ...(check.expectJson != null ? { json: check.expectJson } : {}),
        ...(check.expectHeaders != null ? { headers: check.expectHeaders } : {}),
      },
      points: check.points,
    })),
  })
}
```

`js-yaml` is already imported as `* as yaml` at the top of this file — no new import needed for `buildChallengeYaml` itself.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest tests/challenges.service.test.ts`
Expected: PASS, all cases green (existing `parseChallengeYaml`/`sumPoints`/`seedChallengesFromDirectory` tests plus every new case above).

- [ ] **Step 5: Commit**

```bash
git add backend/src/challenges/service.ts backend/tests/challenges.service.test.ts
git commit -m "feat: add admin challenge CRUD and YAML serialization to challenges/service.ts"
```

---

## Task 3: `challenges/admin-routes.ts` — HTTP layer + `app.ts` wiring

**Files:**
- Create: `backend/src/challenges/admin-routes.ts`
- Test: `backend/tests/challenges.admin.routes.test.ts`
- Modify: `backend/src/app.ts`

**Interfaces:**
- Consumes: `service.ts`'s `createChallenge`/`updateChallenge`/`setChallengeArchived`/`listAdminChallenges`/`getAdminChallenge` (Task 2); `requireAuth`/`requireAdmin` (existing).
- Produces: `createChallengesAdminRouter(prisma: PrismaClient): Router` — mounted in `app.ts`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/challenges.admin.routes.test.ts`:

```ts
import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

let mockAuthUser = { id: 'challenges-admin-routes-test-admin', isAdmin: true }

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
const ADMIN_USER_ID = 'challenges-admin-routes-test-admin'
const NON_ADMIN_USER_ID = 'challenges-admin-routes-test-non-admin'

const VALID_BODY = {
  title: 'Admin Routes Test Challenge',
  category: 'crud',
  checks: [{ name: 'GET /ping', method: 'GET', path: '/ping', expectStatus: 200, points: 10 }],
}

describe('challenges admin routes', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: ADMIN_USER_ID },
      update: { isAdmin: true },
      create: { id: ADMIN_USER_ID, githubId: 'gh-challenges-admin-routes-admin', username: 'admin-octocat', isAdmin: true },
    })
    await prisma.user.upsert({
      where: { id: NON_ADMIN_USER_ID },
      update: { isAdmin: false },
      create: { id: NON_ADMIN_USER_ID, githubId: 'gh-challenges-admin-routes-plain', username: 'plain-octocat', isAdmin: false },
    })
  })

  afterEach(async () => {
    await prisma.challengeCheck.deleteMany({ where: { challenge: { title: { startsWith: 'Admin Routes Test' } } } })
    await prisma.challenge.deleteMany({ where: { title: { startsWith: 'Admin Routes Test' } } })
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: ADMIN_USER_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: NON_ADMIN_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  beforeEach(() => {
    mockAuthUser = { id: ADMIN_USER_ID, isAdmin: true }
  })

  it('every route requires auth (401) and admin (403)', async () => {
    const app = createApp({ prisma })

    expect((await request(app).get('/api/admin/challenges')).status).toBe(401)
    expect((await request(app).post('/api/admin/challenges').send(VALID_BODY)).status).toBe(401)

    mockAuthUser = { id: NON_ADMIN_USER_ID, isAdmin: false }
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')
    expect((await agent.get('/api/admin/challenges')).status).toBe(403)
    expect((await agent.post('/api/admin/challenges').send(VALID_BODY)).status).toBe(403)
  })

  it('full lifecycle: create -> appears in list -> get detail -> update -> archive', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const createRes = await agent.post('/api/admin/challenges').send(VALID_BODY)
    expect(createRes.status).toBe(201)
    const challengeId = createRes.body.challengeId

    const listRes = await agent.get('/api/admin/challenges')
    expect(listRes.status).toBe(200)
    const listEntry = listRes.body.find((c: any) => c.id === challengeId)
    expect(listEntry).toMatchObject({ title: 'Admin Routes Test Challenge', points: 10, archived: false, source: 'database' })

    const getRes = await agent.get(`/api/admin/challenges/${challengeId}`)
    expect(getRes.status).toBe(200)
    expect(getRes.body.checks).toHaveLength(1)

    const updateRes = await agent.put(`/api/admin/challenges/${challengeId}`).send({
      ...VALID_BODY,
      title: 'Admin Routes Test Challenge (updated)',
      checks: [
        { name: 'GET /ping', method: 'GET', path: '/ping', expectStatus: 200, points: 5 },
        { name: 'GET /pong', method: 'GET', path: '/pong', expectStatus: 200, points: 5 },
      ],
    })
    expect(updateRes.status).toBe(200)

    const afterUpdate = await agent.get(`/api/admin/challenges/${challengeId}`)
    expect(afterUpdate.body.title).toBe('Admin Routes Test Challenge (updated)')
    expect(afterUpdate.body.checks).toHaveLength(2)

    const archiveRes = await agent.put(`/api/admin/challenges/${challengeId}/archive`).send({ archived: true })
    expect(archiveRes.status).toBe(200)
    expect(archiveRes.body).toEqual({ archived: true })

    const afterArchive = await agent.get('/api/admin/challenges')
    const archivedEntry = afterArchive.body.find((c: any) => c.id === challengeId)
    expect(archivedEntry.archived).toBe(true)
  })

  it('GET /api/admin/challenges/:id returns 404 for an unknown id', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/admin/challenges/does-not-exist')
    expect(res.status).toBe(404)
  })

  it('POST /api/admin/challenges returns 400 for an invalid body', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/admin/challenges').send({ ...VALID_BODY, title: '' })
    expect(res.status).toBe(400)
  })

  it('PUT /api/admin/challenges/:id returns 404 for an unknown id', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.put('/api/admin/challenges/does-not-exist').send(VALID_BODY)
    expect(res.status).toBe(404)
  })

  it('PUT /api/admin/challenges/:id returns 400 for a file-seeded challenge', async () => {
    const fileChallenge = await prisma.challenge.create({
      data: { title: 'Admin Routes Test File Challenge', category: 'crud', points: 10, yamlPath: 'todo-api-crud.yaml' },
    })

    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.put(`/api/admin/challenges/${fileChallenge.id}`).send(VALID_BODY)
    expect(res.status).toBe(400)

    await prisma.challenge.delete({ where: { id: fileChallenge.id } }).catch(() => {})
  })

  it('PUT /api/admin/challenges/:id/archive returns 400 for a non-boolean archived value', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const createRes = await agent.post('/api/admin/challenges').send(VALID_BODY)
    const res = await agent.put(`/api/admin/challenges/${createRes.body.challengeId}/archive`).send({ archived: 'yes' })
    expect(res.status).toBe(400)
  })

  it('PUT /api/admin/challenges/:id/archive returns 404 for an unknown id', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.put('/api/admin/challenges/does-not-exist/archive').send({ archived: true })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest tests/challenges.admin.routes.test.ts`
Expected: FAIL — routes don't exist yet (404s).

- [ ] **Step 3: Write `challenges/admin-routes.ts`**

Create `backend/src/challenges/admin-routes.ts`:

```ts
import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { requireAuth } from '../auth/middleware'
import { requireAdmin } from '../admin/middleware'
import {
  createChallenge,
  updateChallenge,
  setChallengeArchived,
  listAdminChallenges,
  getAdminChallenge,
  ChallengeInput,
} from './service'

function parseChallengeInputBody(body: any): ChallengeInput {
  return {
    title: body?.title,
    description: body?.description,
    objective: body?.objective,
    technicalDetails: body?.technicalDetails,
    category: body?.category,
    checks: Array.isArray(body?.checks) ? body.checks : [],
  }
}

export function createChallengesAdminRouter(prisma: PrismaClient): Router {
  const router = Router()

  router.get('/api/admin/challenges', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const challenges = await listAdminChallenges(prisma)
      res.json(challenges)
    } catch (err) {
      console.error('Failed to list challenges:', err)
      res.status(500).json({ error: 'failed to list challenges' })
    }
  })

  router.get('/api/admin/challenges/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const challenge = await getAdminChallenge(prisma, req.params.id)
      if (!challenge) {
        res.status(404).json({ error: 'challenge_not_found' })
        return
      }
      res.json(challenge)
    } catch (err) {
      console.error('Failed to load challenge:', err)
      res.status(500).json({ error: 'failed to load challenge' })
    }
  })

  router.post('/api/admin/challenges', requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await createChallenge(prisma, parseChallengeInputBody(req.body))
      if (result.kind === 'validation_error') {
        res.status(400).json({ error: result.error })
        return
      }
      res.status(201).json({ challengeId: result.challengeId })
    } catch (err) {
      console.error('Failed to create challenge:', err)
      res.status(500).json({ error: 'failed to create challenge' })
    }
  })

  router.put('/api/admin/challenges/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await updateChallenge(prisma, req.params.id, parseChallengeInputBody(req.body))
      if (result.kind === 'not_found') {
        res.status(404).json({ error: 'challenge_not_found' })
        return
      }
      if (result.kind === 'file_defined') {
        res.status(400).json({ error: 'challenge is file-defined, not editable' })
        return
      }
      if (result.kind === 'validation_error') {
        res.status(400).json({ error: result.error })
        return
      }
      res.json({ challengeId: result.challengeId })
    } catch (err) {
      console.error('Failed to update challenge:', err)
      res.status(500).json({ error: 'failed to update challenge' })
    }
  })

  router.put('/api/admin/challenges/:id/archive', requireAuth, requireAdmin, async (req, res) => {
    try {
      const archived = req.body?.archived
      if (typeof archived !== 'boolean') {
        res.status(400).json({ error: 'archived must be a boolean' })
        return
      }
      const result = await setChallengeArchived(prisma, req.params.id, archived)
      if (result.kind === 'not_found') {
        res.status(404).json({ error: 'challenge_not_found' })
        return
      }
      res.json({ archived })
    } catch (err) {
      console.error('Failed to update challenge archive state:', err)
      res.status(500).json({ error: 'failed to update challenge archive state' })
    }
  })

  return router
}
```

Modify `backend/src/app.ts` — add the import:
```ts
import { createChallengesAdminRouter } from './challenges/admin-routes'
```
and mount it next to the existing `createChallengesRouter` line:
```ts
  app.use(createChallengesRouter(prisma))
  app.use(createChallengesAdminRouter(prisma))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest tests/challenges.admin.routes.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/challenges/admin-routes.ts backend/src/app.ts backend/tests/challenges.admin.routes.test.ts
git commit -m "feat: add admin challenge CRUD routes"
```

---

## Task 4: Public challenge routes — archived filter + detail text fields

**Files:**
- Modify: `backend/src/challenges/routes.ts`
- Test: `backend/tests/challenges.routes.test.ts` (extended)

**Interfaces:**
- Consumes: `Challenge.archived`/`description`/`objective`/`technicalDetails` (Task 1).
- Produces: nothing new consumed by later tasks — this closes the public-route side of the archived-challenge contract Task 5 also relies on independently in `runs/service.ts`.

- [ ] **Step 1: Write the failing test**

Modify `backend/tests/challenges.routes.test.ts` — extend the existing `describe('Challenge catalog routes', ...)` block. Add to the `beforeAll` (alongside the existing `catalog-test-challenge` upsert) an archived fixture and a fixture with the new text fields:

```ts
    await prisma.challenge.upsert({
      where: { id: 'catalog-test-archived-challenge' },
      update: { archived: true },
      create: {
        id: 'catalog-test-archived-challenge',
        title: 'Archived Test Challenge',
        category: 'crud',
        points: 5,
        yamlPath: 'catalog-test-archived-challenge.yaml',
        archived: true,
      },
    })
    await prisma.challenge.upsert({
      where: { id: 'catalog-test-challenge-with-text' },
      update: {},
      create: {
        id: 'catalog-test-challenge-with-text',
        title: 'Challenge With Text',
        category: 'crud',
        points: 5,
        yamlPath: 'catalog-test-challenge-with-text.yaml',
        description: 'Some description',
        objective: 'Some objective',
        technicalDetails: 'Some technical details',
      },
    })
```

And extend the `afterAll` cleanup:
```ts
    await prisma.challenge.delete({ where: { id: 'catalog-test-archived-challenge' } }).catch(() => {})
    await prisma.challenge.delete({ where: { id: 'catalog-test-challenge-with-text' } }).catch(() => {})
```

Add new `it` blocks inside the same `describe`:

```ts
  it('GET /api/challenges excludes archived challenges', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges')

    expect(res.status).toBe(200)
    expect(res.body.find((c: any) => c.id === 'catalog-test-archived-challenge')).toBeUndefined()
  })

  it('GET /api/challenges/:id returns 404 for an archived challenge', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges/catalog-test-archived-challenge')

    expect(res.status).toBe(404)
  })

  it('GET /api/challenges/:id includes description/objective/technicalDetails when set', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges/catalog-test-challenge-with-text')

    expect(res.status).toBe(200)
    expect(res.body.description).toBe('Some description')
    expect(res.body.objective).toBe('Some objective')
    expect(res.body.technicalDetails).toBe('Some technical details')
  })

  it('GET /api/challenges/:id returns null text fields when unset', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges/catalog-test-challenge')

    expect(res.status).toBe(200)
    expect(res.body.description).toBeNull()
    expect(res.body.objective).toBeNull()
    expect(res.body.technicalDetails).toBeNull()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest tests/challenges.routes.test.ts`
Expected: FAIL — archived challenges still appear, text fields absent from the response.

- [ ] **Step 3: Modify `challenges/routes.ts`**

Replace the two route handlers in `backend/src/challenges/routes.ts`:

```ts
  router.get('/api/challenges', async (_req, res) => {
    const challenges = await prisma.challenge.findMany({
      where: { archived: false },
      select: { id: true, title: true, category: true, points: true },
      orderBy: { createdAt: 'asc' },
    })
    res.json(challenges)
  })

  router.get('/api/challenges/:id', async (req, res) => {
    const challenge = await prisma.challenge.findFirst({
      where: { id: req.params.id, archived: false },
      select: {
        id: true,
        title: true,
        category: true,
        points: true,
        description: true,
        objective: true,
        technicalDetails: true,
      },
    })

    if (!challenge) {
      res.status(404).json({ error: 'challenge_not_found' })
      return
    }

    res.json(challenge)
  })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest tests/challenges.routes.test.ts`
Expected: PASS, all cases (existing + new) green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/challenges/routes.ts backend/tests/challenges.routes.test.ts
git commit -m "feat: exclude archived challenges from the public catalog, expose description/objective/technicalDetails"
```

---

## Task 5: `runs/service.ts` — DB-defined challenge YAML + archived block

**Files:**
- Modify: `backend/src/runs/service.ts`
- Test: `backend/tests/runs.routes.test.ts` (extended), `backend/tests/runs.e2e.test.ts` (extended)

**Interfaces:**
- Consumes: `buildChallengeYaml` (Task 2); `Challenge.archived` (Task 1).
- Produces: nothing consumed by later tasks — this is the last backend task.

- [ ] **Step 1: Write the failing tests**

Modify `backend/tests/runs.routes.test.ts` — add one new `it` inside the existing `describe('POST /api/runs', ...)` block, after the "returns 500 when the challenge YAML file is missing on disk" test:

```ts
  it('returns 400 for an archived challenge, same as a nonexistent one', async () => {
    const archivedChallengeId = 'runs-routes-test-archived-challenge'
    await prisma.challenge.upsert({
      where: { id: archivedChallengeId },
      update: { archived: true },
      create: {
        id: archivedChallengeId,
        title: 'Archived',
        category: 'crud',
        points: 10,
        yamlPath: 'todo-api-crud.yaml',
        archived: true,
      },
    })

    const fetchImpl = jest.fn() as any
    const app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/runs').send({
      challengeId: archivedChallengeId,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })

    expect(res.status).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()

    await prisma.challenge.delete({ where: { id: archivedChallengeId } }).catch(() => {})
  })
```

Modify `backend/tests/runs.e2e.test.ts` — add a second `it` inside the existing `describe('run submission end-to-end', ...)` block, after the file-based one:

```ts
  it('submits against a database-defined challenge by serializing its checks to YAML', async () => {
    const dbChallenge = await prisma.challenge.create({
      data: {
        title: 'E2E DB-Defined Challenge',
        category: 'crud',
        points: 10,
        yamlPath: null,
      },
    })
    await prisma.challengeCheck.create({
      data: {
        challengeId: dbChallenge.id,
        name: 'GET /ping',
        method: 'GET',
        path: '/ping',
        expectStatus: 200,
        points: 10,
        order: 0,
      },
    })

    let app: ReturnType<typeof createApp>
    let capturedYaml = ''

    const fetchImpl = jest.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      capturedYaml = body.challengeYaml
      const webhookUrl = new URL(body.webhookUrl)
      await request(app)
        .post(webhookUrl.pathname + webhookUrl.search)
        .send({
          status: 'completed',
          score: 10,
          checks: [{ name: 'GET /ping', status: 'passed', points: 10, pointsEarned: 10, assertions: [] }],
        })
      return { ok: true, status: 202 } as Response
    }) as any

    app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const submitRes = await agent.post('/api/runs').send({
      challengeId: dbChallenge.id,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })
    expect(submitRes.status).toBe(202)

    const parsedYaml = yaml.load(capturedYaml) as any
    expect(parsedYaml.id).toBe(dbChallenge.id)
    expect(parsedYaml.title).toBe('E2E DB-Defined Challenge')
    expect(parsedYaml.checks).toHaveLength(1)
    expect(parsedYaml.checks[0].request).toEqual({ method: 'GET', path: '/ping' })
    expect(parsedYaml.checks[0].expect).toEqual({ status: 200 })

    const pollRes = await agent.get(`/api/runs/${submitRes.body.runId}`)
    expect(pollRes.body.status).toBe('completed')
    expect(pollRes.body.score).toBe(10)

    await prisma.run.deleteMany({ where: { challengeId: dbChallenge.id } })
    await prisma.challengeCheck.deleteMany({ where: { challengeId: dbChallenge.id } })
    await prisma.challenge.delete({ where: { id: dbChallenge.id } }).catch(() => {})
  })
```

Add `import * as yaml from 'js-yaml'` to the top of `runs.e2e.test.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest tests/runs.routes.test.ts tests/runs.e2e.test.ts`
Expected: FAIL — the archived challenge is still accepted (submitRun doesn't check `archived` yet); the DB-defined challenge submission fails since `challenge.yamlPath` is `null` and `fs.readFileSync(path.join(CHALLENGES_DIR, null), ...)` throws or misbehaves.

- [ ] **Step 3: Modify `runs/service.ts`**

Change the import line:
```ts
import { CHALLENGES_DIR } from '../challenges/service'
```
to:
```ts
import { CHALLENGES_DIR, buildChallengeYaml } from '../challenges/service'
```

Change the challenge lookup:
```ts
  const challenge = await prisma.challenge.findUnique({ where: { id: input.challengeId } })
  if (!challenge) {
    return { kind: 'validation_error', error: 'challenge not found' }
  }
```
to:
```ts
  const challenge = await prisma.challenge.findFirst({ where: { id: input.challengeId, archived: false } })
  if (!challenge) {
    return { kind: 'validation_error', error: 'challenge not found' }
  }
```

Change the YAML-loading step:
```ts
  let challengeYaml: string
  try {
    challengeYaml = fs.readFileSync(path.join(CHALLENGES_DIR, challenge.yamlPath), 'utf-8')
  } catch (err) {
    console.error(`Failed to read challenge YAML for ${challenge.id} at ${challenge.yamlPath}:`, err)
    return { kind: 'internal_error', error: 'failed to load challenge definition' }
  }
```
to:
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest tests/runs.routes.test.ts tests/runs.e2e.test.ts`
Expected: PASS, all cases (existing + new) green.

Run the full backend suite once more:
Run: `cd backend && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/runs/service.ts backend/tests/runs.routes.test.ts backend/tests/runs.e2e.test.ts
git commit -m "feat: block runs against archived challenges, serialize DB-defined challenges to YAML for the validation engine"
```

---

## Task 6: Admin challenge list page + `TopBar` link

**Files:**
- Create: `frontend/app/admin/challenges/page.tsx`
- Test: `frontend/tests/admin-challenges-list.test.tsx`
- Modify: `frontend/app/components/TopBar.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/challenges`, `PUT /api/admin/challenges/:id/archive` (Task 3).
- Produces: nothing consumed by later tasks — links to `/admin/challenges/new` and `/admin/challenges/[id]/edit`, built in Task 8.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/admin-challenges-list.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminChallengesListPage from '../app/admin/challenges/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}))

const ADMIN_ME = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: true }
const NON_ADMIN_ME = { id: '2', username: 'someone', avatarUrl: null, isAdmin: false }
const CHALLENGES = [
  { id: 'db-challenge-1', title: 'DB Challenge', category: 'crud', points: 20, archived: false, source: 'database' },
  { id: 'file-challenge-1', title: 'File Challenge', category: 'auth', points: 15, archived: false, source: 'file' },
]

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

describe('AdminChallengesListPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
  })

  it('shows "Not authorized." for a non-admin user', async () => {
    mockFetch({ me: { status: 200, json: NON_ADMIN_ME }, get: { status: 200, json: CHALLENGES } })

    render(<AdminChallengesListPage />)

    await waitFor(() => {
      expect(screen.getByText('Not authorized.')).toBeInTheDocument()
    })
  })

  it('lists challenges with an Edit link only for database-sourced ones', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: CHALLENGES } })

    render(<AdminChallengesListPage />)

    await waitFor(() => {
      expect(screen.getByText('DB Challenge')).toBeInTheDocument()
    })
    expect(screen.getByText('File Challenge')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /edit/i })).toHaveAttribute('href', '/admin/challenges/db-challenge-1/edit')
  })

  it('renders a "New Challenge" link to /admin/challenges/new', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: CHALLENGES } })

    render(<AdminChallengesListPage />)

    await waitFor(() => screen.getByText('DB Challenge'))
    expect(screen.getByRole('link', { name: /new challenge/i })).toHaveAttribute('href', '/admin/challenges/new')
  })

  it('archives a challenge and reflects the new state', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: CHALLENGES },
      put: { status: 200, json: { archived: true } },
    })
    const user = userEvent.setup()

    render(<AdminChallengesListPage />)
    await waitFor(() => screen.getByText('DB Challenge'))

    await user.click(screen.getAllByRole('button', { name: /archive/i })[0])

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /unarchive/i })[0]).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npx vitest run tests/admin-challenges-list.test.tsx`
Expected: FAIL — `../app/admin/challenges/page` doesn't exist yet.

- [ ] **Step 3: Write the list page**

Create `frontend/app/admin/challenges/page.tsx`:

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

type AdminChallengeListItem = {
  id: string
  title: string
  category: string
  points: number
  archived: boolean
  source: 'file' | 'database'
}

export default function AdminChallengesListPage() {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const challenges = useResource<AdminChallengeListItem[]>('/api/admin/challenges')

  const [items, setItems] = useState<AdminChallengeListItem[] | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  useEffect(() => {
    if (challenges.data) setItems(challenges.data)
  }, [challenges.data])

  function handleToggleArchive(id: string, nextArchived: boolean) {
    setArchiveError(null)
    backendFetch(`/api/admin/challenges/${id}/archive`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: nextArchived }),
    })
      .then((res) => {
        if (res.status === 200) {
          setItems((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, archived: nextArchived } : c)) : prev))
          return
        }
        setArchiveError('Could not update challenge.')
      })
      .catch(() => {
        setArchiveError('Could not update challenge.')
      })
  }

  if (me.loading || challenges.loading) return <p className="state-message">Loading...</p>
  if (me.error) return <p className="state-message">Something went wrong loading this page.</p>
  if (!me.data) return null
  if (!me.data.isAdmin) return <p className="state-message">Not authorized.</p>
  if (challenges.error) return <p className="state-message">Could not load challenges.</p>
  if (!items) return null

  return (
    <div className="page">
      <TopBar location="admin / challenges" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content">
        <div>
          <h1 className="page-title">Challenges</h1>
          <p className="page-subtitle">Create and manage challenges.</p>
        </div>

        <a className="btn btn-primary" href="/admin/challenges/new">
          New Challenge
        </a>

        {archiveError && <p className="form-error">{archiveError}</p>}

        <ul className="challenge-list">
          {items.map((challenge) => (
            <li key={challenge.id} className="challenge-row">
              <span className="challenge-row-title">
                {challenge.title}
                {challenge.archived && <span className="badge-category">archived</span>}
              </span>
              <span className="challenge-row-meta">
                <span className="badge-category">{challenge.category}</span>
                <span className="challenge-row-points">{challenge.points} pts</span>
                {challenge.source === 'database' ? (
                  <a href={`/admin/challenges/${challenge.id}/edit`}>Edit</a>
                ) : (
                  <span>file-defined</span>
                )}
                <button type="button" onClick={() => handleToggleArchive(challenge.id, !challenge.archived)}>
                  {challenge.archived ? 'Unarchive' : 'Archive'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
```

Modify `frontend/app/components/TopBar.tsx` — add one line inside the existing `isAdmin` block, after the `/admin/billing` link:
```tsx
          {isAdmin && (
            <>
              <span className="topbar-admin-tag">admin</span>
              <a href="/admin/llm-settings">LLM</a>
              <a href="/admin/tos">ToS</a>
              <a href="/admin/billing">Billing</a>
              <a href="/admin/challenges">Challenges</a>
            </>
          )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npx vitest run tests/admin-challenges-list.test.tsx`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/admin/challenges/page.tsx frontend/tests/admin-challenges-list.test.tsx frontend/app/components/TopBar.tsx
git commit -m "feat: add admin challenges list page with archive toggle and TopBar link"
```

---

## Task 7: `ChallengeForm` shared component

**Files:**
- Create: `frontend/app/admin/challenges/ChallengeForm.tsx`
- Test: `frontend/tests/admin-challenge-form.test.tsx`

**Interfaces:**
- Consumes: nothing from other tasks — a pure, self-contained form component.
- Produces: `ChallengeForm` component, `ChallengeFormValues` and `ChallengeInput` types — consumed by Task 8's `new`/`edit` pages.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/admin-challenge-form.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import ChallengeForm from '../app/admin/challenges/ChallengeForm'

describe('ChallengeForm', () => {
  it('submits a single check with the exact expected shape', async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true })
    const user = userEvent.setup()

    render(<ChallengeForm onSave={onSave} />)

    await user.type(screen.getByLabelText(/^title$/i), 'My Challenge')
    await user.type(screen.getByLabelText(/^name$/i), 'GET /ping')
    await user.clear(screen.getByLabelText(/^path$/i))
    await user.type(screen.getByLabelText(/^path$/i), '/ping')
    await user.clear(screen.getByLabelText(/expected status/i))
    await user.type(screen.getByLabelText(/expected status/i), '200')
    await user.clear(screen.getByLabelText(/^points$/i))
    await user.type(screen.getByLabelText(/^points$/i), '10')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(onSave).toHaveBeenCalledWith({
      title: 'My Challenge',
      description: undefined,
      objective: undefined,
      technicalDetails: undefined,
      category: 'crud',
      checks: [
        {
          name: 'GET /ping',
          method: 'GET',
          path: '/ping',
          requestHeaders: undefined,
          requestBody: undefined,
          expectStatus: 200,
          expectJson: undefined,
          expectHeaders: undefined,
          points: 10,
        },
      ],
    })
  })

  it('adds and removes request-type rows', async () => {
    const user = userEvent.setup()
    render(<ChallengeForm onSave={vi.fn().mockResolvedValue({ ok: true })} />)

    expect(screen.getAllByLabelText(/^name$/i)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: /add request type/i }))
    expect(screen.getAllByLabelText(/^name$/i)).toHaveLength(2)

    await user.click(screen.getAllByRole('button', { name: /remove request type/i })[0])
    expect(screen.getAllByLabelText(/^name$/i)).toHaveLength(1)
  })

  it('blocks submit and shows an inline error on invalid JSON, without calling onSave', async () => {
    const onSave = vi.fn()
    const user = userEvent.setup()

    render(<ChallengeForm onSave={onSave} />)

    await user.type(screen.getByLabelText(/^title$/i), 'My Challenge')
    await user.type(screen.getByLabelText(/^name$/i), 'GET /ping')
    await user.clear(screen.getByLabelText(/^path$/i))
    await user.type(screen.getByLabelText(/^path$/i), '/ping')
    await user.type(screen.getByLabelText(/request body/i), '{not valid json')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(screen.getByText(/not valid json/i)).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('pre-fills from `initial` and omits optional fields left blank', async () => {
    render(
      <ChallengeForm
        initial={{
          title: 'Existing Challenge',
          description: 'Existing description',
          objective: '',
          technicalDetails: '',
          category: 'auth',
          checks: [
            {
              name: 'POST /login',
              method: 'POST',
              path: '/login',
              requestHeaders: '',
              requestBody: '{"user":"a"}',
              expectStatus: '201',
              expectJson: '',
              expectHeaders: '',
              points: '20',
            },
          ],
        }}
        onSave={vi.fn().mockResolvedValue({ ok: true })}
      />
    )

    expect(screen.getByDisplayValue('Existing Challenge')).toBeInTheDocument()
    expect(screen.getByDisplayValue('POST /login')).toBeInTheDocument()
  })

  it('shows the error onSave returns and stays on the form', async () => {
    // Message is deliberately something only the server could reject (not a client-side
    // `required`-blockable field) — every field the browser's own HTML5 validation would
    // block is filled in, so submission actually reaches `onSave` and its rejection is
    // what surfaces, not native constraint validation short-circuiting first.
    const onSave = vi.fn().mockResolvedValue({ ok: false, error: 'a challenge with this title already exists' })
    const user = userEvent.setup()

    render(<ChallengeForm onSave={onSave} />)

    await user.type(screen.getByLabelText(/^title$/i), 'Duplicate Title')
    await user.type(screen.getByLabelText(/^name$/i), 'GET /ping')
    await user.clear(screen.getByLabelText(/^path$/i))
    await user.type(screen.getByLabelText(/^path$/i), '/ping')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText('a challenge with this title already exists')).toBeInTheDocument()
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npx vitest run tests/admin-challenge-form.test.tsx`
Expected: FAIL — `../app/admin/challenges/ChallengeForm` doesn't exist yet.

- [ ] **Step 3: Write `ChallengeForm.tsx`**

Create `frontend/app/admin/challenges/ChallengeForm.tsx`:

```tsx
'use client'

import { useState } from 'react'

export type ChallengeCheckFormRow = {
  name: string
  method: string
  path: string
  requestHeaders: string
  requestBody: string
  expectStatus: string
  expectJson: string
  expectHeaders: string
  points: string
}

export type ChallengeFormValues = {
  title: string
  description: string
  objective: string
  technicalDetails: string
  category: string
  checks: ChallengeCheckFormRow[]
}

export type ChallengeInput = {
  title: string
  description?: string
  objective?: string
  technicalDetails?: string
  category: string
  checks: {
    name: string
    method: string
    path: string
    requestHeaders?: Record<string, string>
    requestBody?: unknown
    expectStatus: number
    expectJson?: unknown
    expectHeaders?: Record<string, string>
    points: number
  }[]
}

const CATEGORIES = ['crud', 'contract', 'status', 'auth']
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'QUERY']

function emptyCheck(): ChallengeCheckFormRow {
  return {
    name: '',
    method: 'GET',
    path: '',
    requestHeaders: '',
    requestBody: '',
    expectStatus: '200',
    expectJson: '',
    expectHeaders: '',
    points: '10',
  }
}

type ParsedField = { ok: true; value: unknown } | { ok: false; error: string }

function parseOptionalJson(text: string, fieldLabel: string, rowIndex: number): ParsedField {
  if (text.trim().length === 0) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: `Request type ${rowIndex + 1}: ${fieldLabel} is not valid JSON` }
  }
}

type ChallengeFormProps = {
  initial?: ChallengeFormValues
  onSave: (input: ChallengeInput) => Promise<{ ok: true } | { ok: false; error: string }>
}

export default function ChallengeForm({ initial, onSave }: ChallengeFormProps) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [objective, setObjective] = useState(initial?.objective ?? '')
  const [technicalDetails, setTechnicalDetails] = useState(initial?.technicalDetails ?? '')
  const [category, setCategory] = useState(initial?.category ?? CATEGORIES[0])
  const [checks, setChecks] = useState<ChallengeCheckFormRow[]>(initial?.checks ?? [emptyCheck()])
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  function updateCheck(index: number, patch: Partial<ChallengeCheckFormRow>) {
    setChecks((prev) => prev.map((check, i) => (i === index ? { ...check, ...patch } : check)))
  }

  function addCheck() {
    setChecks((prev) => [...prev, emptyCheck()])
  }

  function removeCheck(index: number) {
    setChecks((prev) => prev.filter((_, i) => i !== index))
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)

    const parsedChecks: ChallengeInput['checks'] = []
    for (let i = 0; i < checks.length; i++) {
      const check = checks[i]
      const requestHeaders = parseOptionalJson(check.requestHeaders, 'request headers', i)
      if (!requestHeaders.ok) {
        setFormError(requestHeaders.error)
        return
      }
      const requestBody = parseOptionalJson(check.requestBody, 'request body', i)
      if (!requestBody.ok) {
        setFormError(requestBody.error)
        return
      }
      const expectJson = parseOptionalJson(check.expectJson, 'expected response JSON', i)
      if (!expectJson.ok) {
        setFormError(expectJson.error)
        return
      }
      const expectHeaders = parseOptionalJson(check.expectHeaders, 'expected headers', i)
      if (!expectHeaders.ok) {
        setFormError(expectHeaders.error)
        return
      }

      const expectStatus = Number(check.expectStatus)
      if (!Number.isInteger(expectStatus)) {
        setFormError(`Request type ${i + 1}: expected status must be a whole number`)
        return
      }
      const points = Number(check.points)
      if (!Number.isInteger(points) || points <= 0) {
        setFormError(`Request type ${i + 1}: points must be a positive whole number`)
        return
      }

      parsedChecks.push({
        name: check.name,
        method: check.method,
        path: check.path,
        requestHeaders: requestHeaders.value as Record<string, string> | undefined,
        requestBody: requestBody.value,
        expectStatus,
        expectJson: expectJson.value,
        expectHeaders: expectHeaders.value as Record<string, string> | undefined,
        points,
      })
    }

    setSaving(true)
    onSave({
      title,
      description: description.trim() || undefined,
      objective: objective.trim() || undefined,
      technicalDetails: technicalDetails.trim() || undefined,
      category,
      checks: parsedChecks,
    }).then((result) => {
      setSaving(false)
      if (!result.ok) {
        setFormError(result.error)
      }
    })
  }

  return (
    <form className="panel" onSubmit={handleSubmit}>
      <div className="field">
        <label className="field-label" htmlFor="title">
          Title
        </label>
        <input id="title" value={title} onChange={(event) => setTitle(event.target.value)} required />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="description">
          Description
        </label>
        <textarea id="description" value={description} onChange={(event) => setDescription(event.target.value)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="objective">
          Objective
        </label>
        <textarea id="objective" value={objective} onChange={(event) => setObjective(event.target.value)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="technicalDetails">
          Technical details
        </label>
        <textarea
          id="technicalDetails"
          value={technicalDetails}
          onChange={(event) => setTechnicalDetails(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="category">
          Category
        </label>
        <select id="category" value={category} onChange={(event) => setCategory(event.target.value)}>
          {CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <div>
        <p className="section-label">Request types</p>
        {checks.map((check, index) => (
          <div className="panel" key={index}>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-name`}>
                Name
              </label>
              <input
                id={`check-${index}-name`}
                value={check.name}
                onChange={(event) => updateCheck(index, { name: event.target.value })}
                required
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-method`}>
                Method
              </label>
              <select
                id={`check-${index}-method`}
                value={check.method}
                onChange={(event) => updateCheck(index, { method: event.target.value })}
              >
                {METHODS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-path`}>
                Path
              </label>
              <input
                id={`check-${index}-path`}
                value={check.path}
                onChange={(event) => updateCheck(index, { path: event.target.value })}
                placeholder="/todos"
                required
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-requestHeaders`}>
                Request headers (JSON, optional)
              </label>
              <textarea
                id={`check-${index}-requestHeaders`}
                value={check.requestHeaders}
                onChange={(event) => updateCheck(index, { requestHeaders: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-requestBody`}>
                Request body (JSON, optional)
              </label>
              <textarea
                id={`check-${index}-requestBody`}
                value={check.requestBody}
                onChange={(event) => updateCheck(index, { requestBody: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-expectStatus`}>
                Expected status
              </label>
              <input
                id={`check-${index}-expectStatus`}
                type="number"
                value={check.expectStatus}
                onChange={(event) => updateCheck(index, { expectStatus: event.target.value })}
                required
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-expectJson`}>
                Expected response JSON (optional)
              </label>
              <textarea
                id={`check-${index}-expectJson`}
                value={check.expectJson}
                onChange={(event) => updateCheck(index, { expectJson: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-expectHeaders`}>
                Expected headers (JSON, optional)
              </label>
              <textarea
                id={`check-${index}-expectHeaders`}
                value={check.expectHeaders}
                onChange={(event) => updateCheck(index, { expectHeaders: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`check-${index}-points`}>
                Points
              </label>
              <input
                id={`check-${index}-points`}
                type="number"
                value={check.points}
                onChange={(event) => updateCheck(index, { points: event.target.value })}
                required
              />
            </div>
            {checks.length > 1 && (
              <button type="button" onClick={() => removeCheck(index)}>
                Remove request type
              </button>
            )}
          </div>
        ))}
        <button type="button" onClick={addCheck}>
          Add request type
        </button>
      </div>

      <button className="btn btn-primary" type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      {formError && <p className="form-error">{formError}</p>}
    </form>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npx vitest run tests/admin-challenge-form.test.tsx`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/admin/challenges/ChallengeForm.tsx frontend/tests/admin-challenge-form.test.tsx
git commit -m "feat: add shared ChallengeForm component for creating/editing challenges"
```

---

## Task 8: `/admin/challenges/new` and `/admin/challenges/[id]/edit` pages

**Files:**
- Create: `frontend/app/admin/challenges/new/page.tsx`
- Create: `frontend/app/admin/challenges/[id]/edit/page.tsx`
- Test: `frontend/tests/admin-challenges-new.test.tsx`
- Test: `frontend/tests/admin-challenges-edit.test.tsx`

**Interfaces:**
- Consumes: `ChallengeForm`, `ChallengeInput`, `ChallengeFormValues` (Task 7); `POST`/`PUT`/`GET /api/admin/challenges` (Task 3).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/admin-challenges-new.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminNewChallengePage from '../app/admin/challenges/new/page'

const pushMock = vi.fn()
const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}))

const ADMIN_ME = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: true }
const NON_ADMIN_ME = { id: '2', username: 'someone', avatarUrl: null, isAdmin: false }

function mockFetch(routes: { me?: { status: number; json?: unknown }; post?: { status: number; json?: unknown } }) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/api/me')) {
      return Promise.resolve({ status: routes.me?.status ?? 200, json: async () => routes.me?.json })
    }
    return Promise.resolve({ status: routes.post?.status ?? 500, json: async () => routes.post?.json })
  }) as any
}

describe('AdminNewChallengePage', () => {
  beforeEach(() => {
    pushMock.mockReset()
  })

  it('shows "Not authorized." for a non-admin user', async () => {
    mockFetch({ me: { status: 200, json: NON_ADMIN_ME } })

    render(<AdminNewChallengePage />)

    await waitFor(() => {
      expect(screen.getByText('Not authorized.')).toBeInTheDocument()
    })
  })

  it('creates a challenge and navigates to the list on success', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, post: { status: 201, json: { challengeId: 'new-id' } } })
    const user = userEvent.setup()

    render(<AdminNewChallengePage />)
    await waitFor(() => screen.getByLabelText(/^title$/i))

    await user.type(screen.getByLabelText(/^title$/i), 'New Challenge')
    await user.type(screen.getByLabelText(/^name$/i), 'GET /ping')
    await user.clear(screen.getByLabelText(/^path$/i))
    await user.type(screen.getByLabelText(/^path$/i), '/ping')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/admin/challenges')
    })
  })
})
```

Create `frontend/tests/admin-challenges-edit.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminEditChallengePage from '../app/admin/challenges/[id]/edit/page'

const pushMock = vi.fn()
const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}))

const ADMIN_ME = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: true }
const DETAIL = {
  id: 'existing-id',
  title: 'Existing Challenge',
  description: 'A description',
  objective: undefined,
  technicalDetails: undefined,
  category: 'crud',
  archived: false,
  source: 'database',
  checks: [{ name: 'GET /ping', method: 'GET', path: '/ping', expectStatus: 200, points: 10 }],
}

function mockFetch(routes: {
  me?: { status: number; json?: unknown }
  get?: { status: number; json?: unknown }
  put?: { status: number; json?: unknown }
}) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const isMe = url.includes('/api/me')
    const isPut = init?.method === 'PUT'
    const route = isMe ? routes.me : isPut ? routes.put : routes.get
    return Promise.resolve({ status: route?.status ?? 500, json: async () => route?.json })
  }) as any
}

describe('AdminEditChallengePage', () => {
  beforeEach(() => {
    pushMock.mockReset()
  })

  it('pre-fills the form from the fetched detail', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: DETAIL } })

    render(<AdminEditChallengePage params={{ id: 'existing-id' }} />)

    await waitFor(() => {
      expect(screen.getByDisplayValue('Existing Challenge')).toBeInTheDocument()
    })
    expect(screen.getByDisplayValue('GET /ping')).toBeInTheDocument()
  })

  it('shows a read-only message for a file-defined challenge instead of the form', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: { ...DETAIL, source: 'file' } } })

    render(<AdminEditChallengePage params={{ id: 'existing-id' }} />)

    await waitFor(() => {
      expect(screen.getByText(/defined in a yaml file/i)).toBeInTheDocument()
    })
    expect(screen.queryByDisplayValue('Existing Challenge')).not.toBeInTheDocument()
  })

  it('saves and navigates to the list on success', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: DETAIL },
      put: { status: 200, json: { challengeId: 'existing-id' } },
    })
    const user = userEvent.setup()

    render(<AdminEditChallengePage params={{ id: 'existing-id' }} />)
    await waitFor(() => screen.getByDisplayValue('Existing Challenge'))

    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/admin/challenges')
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npx vitest run tests/admin-challenges-new.test.tsx tests/admin-challenges-edit.test.tsx`
Expected: FAIL — neither page exists yet.

- [ ] **Step 3: Write the two pages**

Create `frontend/app/admin/challenges/new/page.tsx`:

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { useResource, backendFetch } from '../../../lib/api'
import TopBar from '../../../components/TopBar'
import ChallengeForm, { ChallengeInput } from '../ChallengeForm'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
}

export default function AdminNewChallengePage() {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const router = useRouter()

  function handleSave(input: ChallengeInput): Promise<{ ok: true } | { ok: false; error: string }> {
    return backendFetch('/api/admin/challenges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 201) {
          router.push('/admin/challenges')
          return { ok: true as const }
        }
        return { ok: false as const, error: body.error ?? 'Could not create challenge.' }
      })
      .catch(() => ({ ok: false as const, error: 'Could not create challenge.' }))
  }

  if (me.loading) return <p className="state-message">Loading...</p>
  if (me.error) return <p className="state-message">Something went wrong loading this page.</p>
  if (!me.data) return null
  if (!me.data.isAdmin) return <p className="state-message">Not authorized.</p>

  return (
    <div className="page">
      <TopBar location="admin / challenges / new" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content content-narrow">
        <div>
          <h1 className="page-title">New Challenge</h1>
        </div>
        <ChallengeForm onSave={handleSave} />
      </div>
    </div>
  )
}
```

Create `frontend/app/admin/challenges/[id]/edit/page.tsx`:

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { useResource, backendFetch } from '../../../../lib/api'
import TopBar from '../../../../components/TopBar'
import ChallengeForm, { ChallengeInput, ChallengeFormValues } from '../../ChallengeForm'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
}

type AdminChallengeDetail = {
  id: string
  title: string
  description?: string
  objective?: string
  technicalDetails?: string
  category: string
  archived: boolean
  source: 'file' | 'database'
  checks: {
    name: string
    method: string
    path: string
    requestHeaders?: Record<string, string>
    requestBody?: unknown
    expectStatus: number
    expectJson?: unknown
    expectHeaders?: Record<string, string>
    points: number
  }[]
}

function toFormValues(detail: AdminChallengeDetail): ChallengeFormValues {
  return {
    title: detail.title,
    description: detail.description ?? '',
    objective: detail.objective ?? '',
    technicalDetails: detail.technicalDetails ?? '',
    category: detail.category,
    checks: detail.checks.map((check) => ({
      name: check.name,
      method: check.method,
      path: check.path,
      requestHeaders: check.requestHeaders ? JSON.stringify(check.requestHeaders) : '',
      requestBody: check.requestBody !== undefined ? JSON.stringify(check.requestBody) : '',
      expectStatus: String(check.expectStatus),
      expectJson: check.expectJson !== undefined ? JSON.stringify(check.expectJson) : '',
      expectHeaders: check.expectHeaders ? JSON.stringify(check.expectHeaders) : '',
      points: String(check.points),
    })),
  }
}

export default function AdminEditChallengePage({ params }: { params: { id: string } }) {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const detail = useResource<AdminChallengeDetail>(`/api/admin/challenges/${params.id}`)
  const router = useRouter()

  function handleSave(input: ChallengeInput): Promise<{ ok: true } | { ok: false; error: string }> {
    return backendFetch(`/api/admin/challenges/${params.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 200) {
          router.push('/admin/challenges')
          return { ok: true as const }
        }
        return { ok: false as const, error: body.error ?? 'Could not save challenge.' }
      })
      .catch(() => ({ ok: false as const, error: 'Could not save challenge.' }))
  }

  if (me.loading || detail.loading) return <p className="state-message">Loading...</p>
  if (me.error || detail.error) return <p className="state-message">Something went wrong loading this page.</p>
  if (!me.data) return null
  if (!me.data.isAdmin) return <p className="state-message">Not authorized.</p>
  if (detail.notFound) return <p className="state-message">Challenge not found.</p>
  if (!detail.data) return null

  return (
    <div className="page">
      <TopBar location="admin / challenges / edit" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content content-narrow">
        <div>
          <h1 className="page-title">Edit Challenge</h1>
        </div>
        {detail.data.source === 'file' ? (
          <p className="state-message">This challenge is defined in a YAML file and can&apos;t be edited here.</p>
        ) : (
          <ChallengeForm initial={toFormValues(detail.data)} onSave={handleSave} />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npx vitest run tests/admin-challenges-new.test.tsx tests/admin-challenges-edit.test.tsx`
Expected: PASS, all cases green.

Run the full frontend suite to confirm nothing regressed:
Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/admin/challenges/new frontend/app/admin/challenges/[id] frontend/tests/admin-challenges-new.test.tsx frontend/tests/admin-challenges-edit.test.tsx
git commit -m "feat: add admin challenge create and edit pages"
```

---

## Task 9: Challenge detail (take-screen) shows description/objective/technicalDetails

**Files:**
- Modify: `frontend/app/challenges/[id]/page.tsx`
- Test: `frontend/tests/challenges-detail.test.tsx` (extended)

**Interfaces:**
- Consumes: `GET /api/challenges/:id`'s new text fields (Task 4).
- Produces: nothing — last task in this plan.

- [ ] **Step 1: Write the failing test**

Add to `frontend/tests/challenges-detail.test.tsx`, a new `it` inside the existing `describe('ChallengeDetailPage', ...)` block:

```tsx
  it('renders description, objective, and technicalDetails when present', async () => {
    mockFetch({
      get: {
        status: 200,
        json: {
          ...CHALLENGE,
          description: 'Build a small API.',
          objective: 'Prove you can handle CRUD.',
          technicalDetails: 'Use any language you like.',
        },
      },
    })

    render(<ChallengeDetailPage params={{ id: 'todo-api-crud' }} />)

    await waitFor(() => {
      expect(screen.getByText('Build a small API.')).toBeInTheDocument()
    })
    expect(screen.getByText('Prove you can handle CRUD.')).toBeInTheDocument()
    expect(screen.getByText('Use any language you like.')).toBeInTheDocument()
  })

  it('renders no description/objective/technicalDetails sections when all three are absent', async () => {
    mockFetch({ get: { status: 200, json: CHALLENGE } })

    render(<ChallengeDetailPage params={{ id: 'todo-api-crud' }} />)

    await waitFor(() => {
      expect(screen.getByText('Build a Todo CRUD API')).toBeInTheDocument()
    })
    expect(screen.queryByText('Objective')).not.toBeInTheDocument()
    expect(screen.queryByText('Technical Details')).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npx vitest run tests/challenges-detail.test.tsx`
Expected: the first new test ("renders description, objective, and technicalDetails when present") FAILS — none of that text is rendered yet. The second new test ("renders no ... sections when all three are absent") passes vacuously even before implementation, since nothing is rendered either way — that's expected; it becomes a real assertion only once Step 3 adds the conditional rendering.

- [ ] **Step 3: Modify `challenges/[id]/page.tsx`**

Extend the `ChallengeDetail` type:
```ts
type ChallengeDetail = {
  id: string
  title: string
  category: string
  points: number
  description?: string | null
  objective?: string | null
  technicalDetails?: string | null
}
```

Add rendering right after the existing page-subtitle block and before the `<form className="panel" ...>`:
```tsx
        {challenge.data.description && (
          <div>
            <p className="section-label">Description</p>
            <p>{challenge.data.description}</p>
          </div>
        )}
        {challenge.data.objective && (
          <div>
            <p className="section-label">Objective</p>
            <p>{challenge.data.objective}</p>
          </div>
        )}
        {challenge.data.technicalDetails && (
          <div>
            <p className="section-label">Technical Details</p>
            <p>{challenge.data.technicalDetails}</p>
          </div>
        )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npx vitest run tests/challenges-detail.test.tsx`
Expected: PASS, all cases (existing + new) green.

Run the full frontend suite once more:
Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/challenges/[id]/page.tsx frontend/tests/challenges-detail.test.tsx
git commit -m "feat: show description/objective/technicalDetails on the challenge detail page"
```

---

## Final check

- [ ] Run the full backend suite: `cd backend && npm test` — expect all green.
- [ ] Run the full frontend suite: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test` — expect all green.
- [ ] Run `cd backend && npx tsc --noEmit` and `cd frontend && npx tsc --noEmit` — expect no type errors.
- [ ] Manually confirm the 8 existing file-seeded challenges still appear in `/api/challenges` and are unaffected (their `yamlPath` is unchanged, so they take the untouched `fs.readFileSync` path in `runs/service.ts`).
