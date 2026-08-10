# Ranking / Perfil Público Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public, no-login-required ranking of users by total score (sum of best score per completed challenge), and a public profile per user showing which challenges they've attempted and their best score on each. Opt-out via a dashboard checkbox.

**Architecture:** One new `User.hideFromRanking` column; everything else is derived at query time from existing `Run`/`Challenge` data via Prisma `groupBy` — no new tables, no cached/stored aggregate. Two new public (no `requireAuth`) routes plus a `PUT /api/me` for the opt-out toggle. Two new fully-public frontend pages that never call `/api/me`.

**Tech Stack:** Node.js + TypeScript, Express, Prisma (Postgres), Jest + Supertest (backend); Next.js + Vitest + Testing Library (frontend) — all existing conventions, no new dependencies.

## Global Constraints

- No new table for the aggregate score — it's derived via `Run.groupBy` at request time (design spec, "Score Aggregation"). Only `status: 'completed'` runs count; a user with zero completed runs does not appear in the ranking at all (not "score 0").
- Ranking sort: `totalScore DESC, username ASC` (design spec) — deterministic, no extra tiebreak column.
- `hideFromRanking: true` excludes a user from both `GET /api/ranking` and `GET /api/users/:username/profile` — the profile 404s exactly the same way it would for a nonexistent username, so hiding never leaks "this user exists but opted out."
- `targetUrl` (a candidate's or third party's API address) never appears in any ranking/profile response type or Prisma `select` — it has no reason to be public (design spec, "Score Aggregation").
- `GET /api/ranking` and `GET /api/users/:username/profile` have **no** `requireAuth` — they are public by design (design spec, "Backend").
- The frontend `/ranking` and `/u/[username]` pages never call `/api/me` and always render `<TopBar />` with no props (visitor mode) — this is a deliberate scope-narrowing decision (see the design spec's "TopBar público" question) made specifically to avoid extending `useResource`'s 401 handling for a two-page use case. Do not add a `/api/me` fetch to either page.
- `User.username` has no DB-level uniqueness constraint (only `githubId` does) — `getUserProfile` uses `findFirst`, not `findUnique`. This is intentional: GitHub itself guarantees username uniqueness in practice, and adding a unique constraint is out of scope for this feature (no other code path currently relies on username lookups).
- Code style matches the existing codebase exactly: no semicolons, single quotes, 2-space indent (both `backend/` and `frontend/`); dependencies injected via factory functions (`createXRouter(prisma)`); backend tests run against a real Postgres test database via Prisma; frontend tests mock `global.fetch` and `next/navigation`.
- Every test file that creates `Run`/`User`/`Challenge` rows relevant to ranking must scope its cleanup to its own IDs (`deleteMany({ where: { userId: { in: [...] } } })`, never a bare `deleteMany({})` on `Run` or `User` — those tables are shared by many other test files across the suite, unlike the ToS feature's dedicated `TosVersion`/`TosAcceptance` tables).

---

## Task 1: `User.hideFromRanking` data model

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `User.hideFromRanking: boolean` (default `false`) — used by every later task.

- [ ] **Step 1: Add the column**

Modify `backend/prisma/schema.prisma` — add one field to the existing `User` model, right after `isPaid`:

```prisma
model User {
  id        String   @id @default(uuid())
  githubId  String   @unique
  username  String
  avatarUrl String?
  isAdmin   Boolean  @default(false)
  isPaid    Boolean  @default(false)
  hideFromRanking Boolean @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  runs           Run[]
  tosAcceptances TosAcceptance[]
}
```

- [ ] **Step 2: Migrate**

Run:
```bash
cd backend && npx prisma migrate dev --name add_hide_from_ranking
```
Expected: a new folder under `backend/prisma/migrations/`, no drift warning.

Apply to the test database too:
```bash
DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npx prisma migrate deploy
```

- [ ] **Step 3: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "feat: add User.hideFromRanking column"
```

---

## Task 2: `ranking/service.ts` — score aggregation

**Files:**
- Create: `backend/src/ranking/service.ts`
- Test: `backend/tests/ranking.service.test.ts`

**Interfaces:**
- Consumes: `User.hideFromRanking` (Task 1); existing `Run`/`Challenge`/`User` Prisma models.
- Produces (used by Task 3):
  - `RankingEntry = { userId: string; username: string; avatarUrl: string | null; totalScore: number; challengesAttempted: number }`
  - `getRanking(prisma): Promise<RankingEntry[]>`
  - `UserProfile = { username: string; avatarUrl: string | null; totalScore: number; rank: number; challenges: { challengeId: string; title: string; category: string; points: number; bestScore: number }[] }`
  - `getUserProfile(prisma, username: string): Promise<UserProfile | null>`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/ranking.service.test.ts`:

```ts
import { PrismaClient } from '@prisma/client'
import { getRanking, getUserProfile } from '../src/ranking/service'

const prisma = new PrismaClient()

const USER_A = 'ranking-service-test-user-a'
const USER_B = 'ranking-service-test-user-b'
const USER_HIDDEN = 'ranking-service-test-user-hidden'
const CHALLENGE_1 = 'ranking-service-test-challenge-1'
const CHALLENGE_2 = 'ranking-service-test-challenge-2'

async function createRun(userId: string, challengeId: string, status: string, score: number | null) {
  await prisma.run.create({
    data: {
      userId,
      challengeId,
      targetUrl: 'https://example.test',
      status,
      score,
      callbackToken: 'test-token',
    },
  })
}

describe('ranking/service', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_A },
      update: { hideFromRanking: false },
      create: { id: USER_A, githubId: 'gh-ranking-a', username: 'alice-ranking-test', hideFromRanking: false },
    })
    await prisma.user.upsert({
      where: { id: USER_B },
      update: { hideFromRanking: false },
      create: { id: USER_B, githubId: 'gh-ranking-b', username: 'bob-ranking-test', hideFromRanking: false },
    })
    await prisma.user.upsert({
      where: { id: USER_HIDDEN },
      update: { hideFromRanking: true },
      create: { id: USER_HIDDEN, githubId: 'gh-ranking-hidden', username: 'hidden-ranking-test', hideFromRanking: true },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_1 },
      update: {},
      create: { id: CHALLENGE_1, title: 'Ranking Test Challenge One', category: 'crud', points: 25, yamlPath: 'x.yaml' },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_2 },
      update: {},
      create: { id: CHALLENGE_2, title: 'Ranking Test Challenge Two', category: 'auth', points: 25, yamlPath: 'y.yaml' },
    })
  })

  afterEach(async () => {
    await prisma.run.deleteMany({ where: { userId: { in: [USER_A, USER_B, USER_HIDDEN] } } })
  })

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId: { in: [USER_A, USER_B, USER_HIDDEN] } } })
    await prisma.challenge.delete({ where: { id: CHALLENGE_1 } }).catch(() => {})
    await prisma.challenge.delete({ where: { id: CHALLENGE_2 } }).catch(() => {})
    await prisma.user.delete({ where: { id: USER_A } }).catch(() => {})
    await prisma.user.delete({ where: { id: USER_B } }).catch(() => {})
    await prisma.user.delete({ where: { id: USER_HIDDEN } }).catch(() => {})
    await prisma.$disconnect()
  })

  describe('getRanking', () => {
    it('sums the best score per challenge, ignoring non-completed runs', async () => {
      await createRun(USER_A, CHALLENGE_1, 'completed', 40)
      await createRun(USER_A, CHALLENGE_1, 'completed', 90) // best for challenge 1
      await createRun(USER_A, CHALLENGE_2, 'completed', 60)
      await createRun(USER_A, CHALLENGE_2, 'pending', null) // ignored
      await createRun(USER_A, CHALLENGE_2, 'error', null) // ignored

      const ranking = await getRanking(prisma)
      const entry = ranking.find((r) => r.userId === USER_A)

      expect(entry).toEqual({
        userId: USER_A,
        username: 'alice-ranking-test',
        avatarUrl: null,
        totalScore: 150, // 90 + 60
        challengesAttempted: 2,
      })
    })

    it('excludes a user with only non-completed runs', async () => {
      await createRun(USER_A, CHALLENGE_1, 'pending', null)

      const ranking = await getRanking(prisma)
      expect(ranking.find((r) => r.userId === USER_A)).toBeUndefined()
    })

    it('excludes a user with hideFromRanking: true even with completed runs', async () => {
      await createRun(USER_HIDDEN, CHALLENGE_1, 'completed', 100)

      const ranking = await getRanking(prisma)
      expect(ranking.find((r) => r.userId === USER_HIDDEN)).toBeUndefined()
    })

    it('sorts by totalScore desc, then username asc', async () => {
      await createRun(USER_A, CHALLENGE_1, 'completed', 50)
      await createRun(USER_B, CHALLENGE_1, 'completed', 80)

      const ranking = await getRanking(prisma)
      const ids = ranking.filter((r) => r.userId === USER_A || r.userId === USER_B).map((r) => r.userId)
      expect(ids).toEqual([USER_B, USER_A])
    })
  })

  describe('getUserProfile', () => {
    it('returns null for a nonexistent username', async () => {
      expect(await getUserProfile(prisma, 'no-such-user-ranking-test')).toBeNull()
    })

    it('returns null for a hidden user even though they exist', async () => {
      await createRun(USER_HIDDEN, CHALLENGE_1, 'completed', 100)
      expect(await getUserProfile(prisma, 'hidden-ranking-test')).toBeNull()
    })

    it('returns the challenge breakdown and rank for a visible user', async () => {
      await createRun(USER_A, CHALLENGE_1, 'completed', 40)
      await createRun(USER_A, CHALLENGE_1, 'completed', 90)
      await createRun(USER_A, CHALLENGE_2, 'completed', 60)
      await createRun(USER_B, CHALLENGE_1, 'completed', 10) // ranks below USER_A

      const profile = await getUserProfile(prisma, 'alice-ranking-test')

      expect(profile?.username).toBe('alice-ranking-test')
      expect(profile?.totalScore).toBe(150)
      expect(profile?.rank).toBe(1)
      expect(profile?.challenges).toEqual(
        expect.arrayContaining([
          { challengeId: CHALLENGE_1, title: 'Ranking Test Challenge One', category: 'crud', points: 25, bestScore: 90 },
          { challengeId: CHALLENGE_2, title: 'Ranking Test Challenge Two', category: 'auth', points: 25, bestScore: 60 },
        ])
      )
      expect(profile?.challenges).toHaveLength(2)
    })

    it('returns rank: 0 and an empty challenge list for a visible user with no completed runs', async () => {
      const profile = await getUserProfile(prisma, 'alice-ranking-test')

      expect(profile).toEqual({
        username: 'alice-ranking-test',
        avatarUrl: null,
        totalScore: 0,
        rank: 0,
        challenges: [],
      })
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- ranking.service.test.ts`
Expected: FAIL with "Cannot find module '../src/ranking/service'"

- [ ] **Step 3: Write the implementation**

Create `backend/src/ranking/service.ts`:

```ts
import { PrismaClient } from '@prisma/client'

export type RankingEntry = {
  userId: string
  username: string
  avatarUrl: string | null
  totalScore: number
  challengesAttempted: number
}

export async function getRanking(prisma: PrismaClient): Promise<RankingEntry[]> {
  const grouped = await prisma.run.groupBy({
    by: ['userId', 'challengeId'],
    where: { status: 'completed' },
    _max: { score: true },
  })

  const totals = new Map<string, { totalScore: number; challengesAttempted: number }>()
  for (const row of grouped) {
    if (row._max.score === null) continue
    const current = totals.get(row.userId) ?? { totalScore: 0, challengesAttempted: 0 }
    current.totalScore += row._max.score
    current.challengesAttempted += 1
    totals.set(row.userId, current)
  }

  if (totals.size === 0) return []

  const users = await prisma.user.findMany({
    where: { id: { in: [...totals.keys()] }, hideFromRanking: false },
    select: { id: true, username: true, avatarUrl: true },
  })

  const entries: RankingEntry[] = users.map((user) => {
    const total = totals.get(user.id)!
    return {
      userId: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      totalScore: total.totalScore,
      challengesAttempted: total.challengesAttempted,
    }
  })

  entries.sort((a, b) => b.totalScore - a.totalScore || a.username.localeCompare(b.username))
  return entries
}

export type UserProfile = {
  username: string
  avatarUrl: string | null
  totalScore: number
  rank: number
  challenges: { challengeId: string; title: string; category: string; points: number; bestScore: number }[]
}

export async function getUserProfile(prisma: PrismaClient, username: string): Promise<UserProfile | null> {
  const user = await prisma.user.findFirst({ where: { username } })
  if (!user || user.hideFromRanking) return null

  const grouped = await prisma.run.groupBy({
    by: ['challengeId'],
    where: { userId: user.id, status: 'completed' },
    _max: { score: true },
  })

  const scoredRows = grouped.filter((row) => row._max.score !== null)
  const challengeIds = scoredRows.map((row) => row.challengeId)
  const challenges = challengeIds.length
    ? await prisma.challenge.findMany({ where: { id: { in: challengeIds } } })
    : []

  const challengeList = scoredRows
    .map((row) => {
      const challenge = challenges.find((c) => c.id === row.challengeId)!
      return {
        challengeId: challenge.id,
        title: challenge.title,
        category: challenge.category,
        points: challenge.points,
        bestScore: row._max.score!,
      }
    })
    .sort((a, b) => b.bestScore - a.bestScore || a.challengeId.localeCompare(b.challengeId))

  const totalScore = challengeList.reduce((sum, c) => sum + c.bestScore, 0)

  // rank is this user's 1-based position in the same list getRanking() produces — reusing
  // getRanking() here (rather than re-deriving the sort independently) guarantees the two
  // never drift apart.
  const ranking = await getRanking(prisma)
  const position = ranking.findIndex((entry) => entry.userId === user.id)
  const rank = position === -1 ? 0 : position + 1

  return {
    username: user.username,
    avatarUrl: user.avatarUrl,
    totalScore,
    rank,
    challenges: challengeList,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- ranking.service.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/ranking/service.ts backend/tests/ranking.service.test.ts
git commit -m "feat: add ranking/service.ts (score aggregation, user profile)"
```

---

## Task 3: `GET /api/ranking`, `GET /api/users/:username/profile`

**Files:**
- Create: `backend/src/ranking/routes.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/tests/ranking.routes.test.ts`

**Interfaces:**
- Consumes: `getRanking`, `getUserProfile` (Task 2).
- Produces: `createRankingRouter(prisma: PrismaClient): Router`, mounted in `app.ts` — used by the frontend in Tasks 5-6.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/ranking.routes.test.ts`:

```ts
import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

const prisma = new PrismaClient()

const USER_ID = 'ranking-routes-test-user'
const CHALLENGE_ID = 'ranking-routes-test-challenge'

describe('GET /api/ranking', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { hideFromRanking: false },
      create: { id: USER_ID, githubId: 'gh-ranking-routes-test', username: 'ranking-routes-octocat', hideFromRanking: false },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_ID },
      update: {},
      create: { id: CHALLENGE_ID, title: 'Ranking Routes Test Challenge', category: 'crud', points: 25, yamlPath: 'x.yaml' },
    })
  })

  afterEach(async () => {
    await prisma.run.deleteMany({ where: { userId: USER_ID } })
  })

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId: USER_ID } })
    await prisma.challenge.delete({ where: { id: CHALLENGE_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('requires no authentication and returns 200 for an anonymous request', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/ranking')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  it('includes a user with a completed run', async () => {
    await prisma.run.create({
      data: {
        userId: USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://example.test',
        status: 'completed',
        score: 77,
        callbackToken: 'test-token',
      },
    })

    const app = createApp({ prisma })
    const res = await request(app).get('/api/ranking')

    const entry = res.body.find((r: any) => r.userId === USER_ID)
    expect(entry).toEqual({
      userId: USER_ID,
      username: 'ranking-routes-octocat',
      avatarUrl: null,
      totalScore: 77,
      challengesAttempted: 1,
    })
  })
})

describe('GET /api/users/:username/profile', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { hideFromRanking: false },
      create: { id: USER_ID, githubId: 'gh-ranking-routes-test', username: 'ranking-routes-octocat', hideFromRanking: false },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_ID },
      update: {},
      create: { id: CHALLENGE_ID, title: 'Ranking Routes Test Challenge', category: 'crud', points: 25, yamlPath: 'x.yaml' },
    })
  })

  afterEach(async () => {
    await prisma.run.deleteMany({ where: { userId: USER_ID } })
  })

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId: USER_ID } })
    await prisma.challenge.delete({ where: { id: CHALLENGE_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('returns 404 for a nonexistent username, no auth required', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/users/no-such-user-anywhere/profile')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'user_not_found' })
  })

  it('returns the profile for an existing, visible username', async () => {
    await prisma.run.create({
      data: {
        userId: USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://example.test',
        status: 'completed',
        score: 88,
        callbackToken: 'test-token',
      },
    })

    const app = createApp({ prisma })
    const res = await request(app).get('/api/users/ranking-routes-octocat/profile')

    expect(res.status).toBe(200)
    expect(res.body.username).toBe('ranking-routes-octocat')
    expect(res.body.totalScore).toBe(88)
    expect(res.body.challenges).toHaveLength(1)
    expect(res.body.challenges[0]).toEqual({
      challengeId: CHALLENGE_ID,
      title: 'Ranking Routes Test Challenge',
      category: 'crud',
      points: 25,
      bestScore: 88,
    })
  })

  it('returns 404 for a hidden user, same shape as nonexistent', async () => {
    await prisma.user.update({ where: { id: USER_ID }, data: { hideFromRanking: true } })

    const app = createApp({ prisma })
    const res = await request(app).get('/api/users/ranking-routes-octocat/profile')

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'user_not_found' })

    await prisma.user.update({ where: { id: USER_ID }, data: { hideFromRanking: false } })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- ranking.routes.test.ts`
Expected: FAIL — routes don't exist yet, requests 404 from Express's default handler instead of the expected bodies (the "requires no auth" test may pass coincidentally with a 404 status only if you assert exact body too — the assertions above use `res.body` shape checks that a bare 404 won't satisfy).

- [ ] **Step 3: Write the implementation**

Create `backend/src/ranking/routes.ts`:

```ts
import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { getRanking, getUserProfile } from './service'

export function createRankingRouter(prisma: PrismaClient): Router {
  const router = Router()

  router.get('/api/ranking', async (_req, res) => {
    const ranking = await getRanking(prisma)
    res.json(ranking)
  })

  router.get('/api/users/:username/profile', async (req, res) => {
    const profile = await getUserProfile(prisma, req.params.username)
    if (!profile) {
      res.status(404).json({ error: 'user_not_found' })
      return
    }
    res.json(profile)
  })

  return router
}
```

Modify `backend/src/app.ts` — add the import next to `createTosRouter`:

```ts
import { createTosRouter } from './tos/routes'
import { createRankingRouter } from './ranking/routes'
```

And mount it next to the other routers:

```ts
  app.use(createTosRouter(prisma))
  app.use(createRankingRouter(prisma))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- ranking.routes.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test`
Expected: PASS (all suites)

- [ ] **Step 6: Commit**

```bash
git add backend/src/ranking/routes.ts backend/src/app.ts backend/tests/ranking.routes.test.ts
git commit -m "feat: add GET /api/ranking and GET /api/users/:username/profile"
```

---

## Task 4: `hideFromRanking` on `/api/me`, new `PUT /api/me`

**Files:**
- Modify: `backend/src/users/routes.ts`
- Modify: `backend/tests/me.routes.test.ts`

**Interfaces:**
- Consumes: `User.hideFromRanking` (Task 1).
- Produces: `GET /api/me` response gains `hideFromRanking: boolean`; new `PUT /api/me` route accepting `{ hideFromRanking: boolean }`, returning the same shape as `GET /api/me` — used by the frontend in Task 7.

- [ ] **Step 1: Write the failing test**

Modify `backend/tests/me.routes.test.ts` — update the existing "returns the current user when authenticated" test's expected body:

```ts
  it('returns the current user when authenticated', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)

    await agent.get('/auth/github/callback')
    const res = await agent.get('/api/me')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      id: 'test-user-id',
      username: 'octocat',
      avatarUrl: null,
      isAdmin: true,
      tosAcceptanceRequired: false,
      hideFromRanking: false,
    })
  })
```

Append two new tests to the same `describe('GET /api/me', ...)` block (note: despite the `describe` name, `PUT` tests belong in this file too — it's the whole `/api/me` surface):

```ts
  it('PUT requires authentication', async () => {
    const app = createApp({ prisma })
    const res = await request(app).put('/api/me').send({ hideFromRanking: true })
    expect(res.status).toBe(401)
  })

  it('PUT updates hideFromRanking and GET reflects it afterward', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const put = await agent.put('/api/me').send({ hideFromRanking: true })
    expect(put.status).toBe(200)
    expect(put.body.hideFromRanking).toBe(true)

    const after = await agent.get('/api/me')
    expect(after.body.hideFromRanking).toBe(true)

    // restore default so this test doesn't leak state into other tests in this file
    await agent.put('/api/me').send({ hideFromRanking: false })
  })

  it('PUT returns 400 when hideFromRanking is not a boolean', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.put('/api/me').send({ hideFromRanking: 'yes' })
    expect(res.status).toBe(400)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- me.routes.test.ts`
Expected: FAIL — `GET` response has no `hideFromRanking` key; `PUT /api/me` doesn't exist yet (404s).

- [ ] **Step 3: Write the implementation**

Modify `backend/src/users/routes.ts` — replace the whole file:

```ts
import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { requireAuth } from '../auth/middleware'
import { isTosAcceptanceRequired } from '../tos/service'

type AuthenticatedUser = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
}

export function createMeRouter(prisma: PrismaClient): Router {
  const router = Router()

  async function buildMeResponse(user: AuthenticatedUser) {
    let tosAcceptanceRequired = false
    try {
      tosAcceptanceRequired = await isTosAcceptanceRequired(prisma, user.id)
    } catch (err) {
      console.error(`Failed to determine tosAcceptanceRequired for user ${user.id}:`, err)
    }

    const dbUser = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { hideFromRanking: true },
    })

    return {
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin,
      tosAcceptanceRequired,
      hideFromRanking: dbUser.hideFromRanking,
    }
  }

  router.get('/api/me', requireAuth, async (req, res) => {
    const user = req.user as AuthenticatedUser
    res.json(await buildMeResponse(user))
  })

  router.put('/api/me', requireAuth, async (req, res) => {
    const user = req.user as AuthenticatedUser
    const hideFromRanking = req.body?.hideFromRanking

    if (typeof hideFromRanking !== 'boolean') {
      res.status(400).json({ error: 'hideFromRanking must be a boolean' })
      return
    }

    await prisma.user.update({ where: { id: user.id }, data: { hideFromRanking } })
    res.json(await buildMeResponse(user))
  })

  return router
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- me.routes.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test`
Expected: PASS (all suites)

- [ ] **Step 6: Commit**

```bash
git add backend/src/users/routes.ts backend/tests/me.routes.test.ts
git commit -m "feat: add hideFromRanking to /api/me, add PUT /api/me"
```

---

## Task 5: Frontend `/ranking` page

**Files:**
- Create: `frontend/app/ranking/page.tsx`
- Test: `frontend/tests/ranking-page.test.tsx`

**Interfaces:**
- Consumes: `useResource` (existing, `frontend/app/lib/api.ts`); `GET /api/ranking` (Task 3).
- Produces: nothing for later tasks — this page is a leaf. `/u/[username]` links it targets are built in Task 6.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/ranking-page.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import RankingPage from '../app/ranking/page'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

const RANKING = [
  { userId: '1', username: 'alice', avatarUrl: null, totalScore: 150, challengesAttempted: 2 },
  { userId: '2', username: 'bob', avatarUrl: null, totalScore: 90, challengesAttempted: 1 },
]

function mockFetch(routes: { get?: { status: number; json?: unknown } }) {
  global.fetch = vi.fn(() => {
    const route = routes.get
    return Promise.resolve({ status: route?.status ?? 500, json: async () => route?.json })
  }) as any
}

describe('RankingPage', () => {
  it('never fetches /api/me', async () => {
    mockFetch({ get: { status: 200, json: RANKING } })

    render(<RankingPage />)
    await waitFor(() => screen.getByText('alice'))

    const calledUrls = (global.fetch as any).mock.calls.map((call: any[]) => call[0])
    expect(calledUrls.some((url: string) => url.includes('/api/me'))).toBe(false)
  })

  it('renders each entry with rank position, username, and score, linking to the profile', async () => {
    mockFetch({ get: { status: 200, json: RANKING } })

    render(<RankingPage />)

    await waitFor(() => screen.getByText('alice'))
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByText(/150/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /alice/i })).toHaveAttribute('href', '/u/alice')
  })

  it('shows an error message instead of an infinite spinner when the request fails', async () => {
    mockFetch({ get: { status: 500 } })

    render(<RankingPage />)

    await waitFor(() => {
      expect(screen.getByText(/could not load the ranking/i)).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test -- ranking-page.test.tsx`
Expected: FAIL with "Cannot find module '../app/ranking/page'"

- [ ] **Step 3: Write the implementation**

Create `frontend/app/ranking/page.tsx`:

```tsx
'use client'

import { useResource } from '../lib/api'
import TopBar from '../components/TopBar'

type RankingEntry = {
  userId: string
  username: string
  avatarUrl: string | null
  totalScore: number
  challengesAttempted: number
}

export default function RankingPage() {
  const ranking = useResource<RankingEntry[]>('/api/ranking')

  if (ranking.loading) return <p className="state-message">Loading...</p>
  if (ranking.error) return <p className="state-message">Could not load the ranking.</p>
  if (!ranking.data) return null

  return (
    <div className="page">
      <TopBar location="ranking" />
      <div className="content">
        <div>
          <h1 className="page-title">Ranking</h1>
          <p className="page-subtitle">Sum of each user&apos;s best score per challenge attempted.</p>
        </div>

        {ranking.data.length === 0 ? (
          <p className="muted">No one has completed a challenge yet.</p>
        ) : (
          <ul className="challenge-list">
            {ranking.data.map((entry, index) => (
              <li key={entry.userId}>
                <a className="challenge-row" href={`/u/${entry.username}`}>
                  <span className="challenge-row-title">
                    #{index + 1} {entry.username}
                  </span>
                  <span className="challenge-row-meta">
                    <span className="badge-category">{entry.challengesAttempted} challenges</span>
                    <span className="challenge-row-points">{entry.totalScore} pts</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test -- ranking-page.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/ranking frontend/tests/ranking-page.test.tsx
git commit -m "feat: add public /ranking page"
```

---

## Task 6: Frontend `/u/[username]` profile page

**Files:**
- Create: `frontend/app/u/[username]/page.tsx`
- Test: `frontend/tests/user-profile-page.test.tsx`

**Interfaces:**
- Consumes: `useResource` (existing); `GET /api/users/:username/profile` (Task 3).
- Produces: nothing for later tasks — leaf page.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/user-profile-page.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import UserProfilePage from '../app/u/[username]/page'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

const PROFILE = {
  username: 'alice',
  avatarUrl: null,
  totalScore: 150,
  rank: 1,
  challenges: [
    { challengeId: 'todo-api-crud', title: 'Build a Todo CRUD API', category: 'crud', points: 25, bestScore: 90 },
    { challengeId: 'jwt-auth-basics', title: 'JWT Auth Basics', category: 'auth', points: 25, bestScore: 60 },
  ],
}

function mockFetch(routes: { get?: { status: number; json?: unknown } }) {
  global.fetch = vi.fn(() => {
    const route = routes.get
    return Promise.resolve({ status: route?.status ?? 500, json: async () => route?.json })
  }) as any
}

describe('UserProfilePage', () => {
  it('never fetches /api/me', async () => {
    mockFetch({ get: { status: 200, json: PROFILE } })

    render(<UserProfilePage params={{ username: 'alice' }} />)
    await waitFor(() => screen.getByText('alice'))

    const calledUrls = (global.fetch as any).mock.calls.map((call: any[]) => call[0])
    expect(calledUrls.some((url: string) => url.includes('/api/me'))).toBe(false)
  })

  it('renders username, rank, total score, and each attempted challenge with its best score', async () => {
    mockFetch({ get: { status: 200, json: PROFILE } })

    render(<UserProfilePage params={{ username: 'alice' }} />)

    await waitFor(() => screen.getByText('alice'))
    expect(screen.getByText(/150/)).toBeInTheDocument()
    expect(screen.getByText('Build a Todo CRUD API')).toBeInTheDocument()
    expect(screen.getByText(/90/)).toBeInTheDocument()
    expect(screen.getByText('JWT Auth Basics')).toBeInTheDocument()
  })

  it('shows "User not found." for a 404', async () => {
    mockFetch({ get: { status: 404, json: { error: 'user_not_found' } } })

    render(<UserProfilePage params={{ username: 'does-not-exist' }} />)

    await waitFor(() => {
      expect(screen.getByText('User not found.')).toBeInTheDocument()
    })
  })

  it('shows a message instead of the challenge list when rank is 0 (no activity yet)', async () => {
    mockFetch({ get: { status: 200, json: { ...PROFILE, totalScore: 0, rank: 0, challenges: [] } } })

    render(<UserProfilePage params={{ username: 'alice' }} />)

    await waitFor(() => {
      expect(screen.getByText(/not yet ranked/i)).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test -- user-profile-page.test.tsx`
Expected: FAIL with "Cannot find module '../app/u/[username]/page'"

- [ ] **Step 3: Write the implementation**

Create `frontend/app/u/[username]/page.tsx`:

```tsx
'use client'

import { useResource } from '../../lib/api'
import TopBar from '../../components/TopBar'

type UserProfile = {
  username: string
  avatarUrl: string | null
  totalScore: number
  rank: number
  challenges: { challengeId: string; title: string; category: string; points: number; bestScore: number }[]
}

export default function UserProfilePage({ params }: { params: { username: string } }) {
  const profile = useResource<UserProfile>(`/api/users/${params.username}/profile`)

  if (profile.loading) return <p className="state-message">Loading...</p>
  if (profile.notFound) return <p className="state-message">User not found.</p>
  if (profile.error) return <p className="state-message">Could not load this profile.</p>
  if (!profile.data) return null

  return (
    <div className="page">
      <TopBar location={profile.data.username} />
      <div className="content content-narrow">
        <div>
          <h1 className="page-title">{profile.data.username}</h1>
          <p className="page-subtitle">
            {profile.data.rank > 0 ? (
              <>
                Rank #{profile.data.rank} &middot; {profile.data.totalScore} pts total
              </>
            ) : (
              'Not yet ranked — no completed challenges.'
            )}
          </p>
        </div>

        {profile.data.challenges.length > 0 && (
          <div>
            <p className="section-label" style={{ marginBottom: 'var(--space-3)' }}>
              Challenges
            </p>
            <ul className="challenge-list">
              {profile.data.challenges.map((challenge) => (
                <li key={challenge.challengeId}>
                  <span className="challenge-row">
                    <span className="challenge-row-title">{challenge.title}</span>
                    <span className="challenge-row-meta">
                      <span className="badge-category">{challenge.category}</span>
                      <span className="challenge-row-points">{challenge.bestScore}/{challenge.points} pts</span>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test -- user-profile-page.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add "frontend/app/u" frontend/tests/user-profile-page.test.tsx
git commit -m "feat: add public /u/[username] profile page"
```

---

## Task 7: Dashboard opt-out toggle + `TopBar` Ranking link

**Files:**
- Modify: `frontend/app/dashboard/page.tsx`
- Modify: `frontend/app/components/TopBar.tsx`
- Modify: `frontend/tests/dashboard.test.tsx`

**Interfaces:**
- Consumes: `PUT /api/me` (Task 4); `hideFromRanking` on `GET /api/me` (Task 4).
- Produces: nothing for later tasks — leaf task.

- [ ] **Step 1: Write the failing tests**

Modify `frontend/tests/dashboard.test.tsx` — add `hideFromRanking: false` to `ME_RESPONSE`:

```ts
const ME_RESPONSE = {
  id: '1',
  username: 'octocat',
  avatarUrl: null,
  isAdmin: false,
  tosAcceptanceRequired: false,
  hideFromRanking: false,
}
```

Modify the file's `mockFetch` helper so a `PUT` request can be distinguished and mocked separately from the existing `GET`-only routing (the current helper only branches on URL substring, not method — add a `put` route alongside the existing keys):

```ts
function mockFetch(routes: Record<string, { status: number; json?: unknown }> & { put?: { status: number; json?: unknown } }) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const route = routes.put ?? { status: 500 }
      return Promise.resolve({ status: route.status, json: async () => route.json })
    }
    const match = Object.keys(routes).find((path) => path !== 'put' && url.includes(path))
    const route = match ? (routes as Record<string, { status: number; json?: unknown }>)[match] : { status: 500 }
    return Promise.resolve({
      status: route.status,
      json: async () => route.json,
    })
  }) as any
}
```

Append a new test to the `describe('DashboardPage', ...)` block:

```ts
  it('toggles hideFromRanking via PUT /api/me and reflects the new value', async () => {
    mockFetch({
      '/api/me': { status: 200, json: ME_RESPONSE },
      '/api/challenges': { status: 200, json: [] },
      put: { status: 200, json: { ...ME_RESPONSE, hideFromRanking: true } },
    })
    const user = userEvent.setup()

    render(<DashboardPage />)
    await waitFor(() => screen.getByLabelText(/hide from public ranking/i))

    const checkbox = screen.getByLabelText(/hide from public ranking/i) as HTMLInputElement
    expect(checkbox.checked).toBe(false)

    await user.click(checkbox)

    await waitFor(() => {
      expect(checkbox.checked).toBe(true)
    })
  })

  it('reverts the checkbox and shows an error when the PUT fails', async () => {
    mockFetch({
      '/api/me': { status: 200, json: ME_RESPONSE },
      '/api/challenges': { status: 200, json: [] },
      put: { status: 500 },
    })
    const user = userEvent.setup()

    render(<DashboardPage />)
    await waitFor(() => screen.getByLabelText(/hide from public ranking/i))

    const checkbox = screen.getByLabelText(/hide from public ranking/i) as HTMLInputElement
    await user.click(checkbox)

    await waitFor(() => {
      expect(checkbox.checked).toBe(false)
    })
    expect(screen.getByText(/could not save/i)).toBeInTheDocument()
  })
```

Add the `userEvent` import at the top of the file if it isn't already there:

```ts
import userEvent from '@testing-library/user-event'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test -- dashboard.test.tsx`
Expected: FAIL — no checkbox exists yet, `getByLabelText` throws.

- [ ] **Step 3: Write the implementation**

Modify `frontend/app/dashboard/page.tsx` — full replacement:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useResource, useTosGate, backendFetch } from '../lib/api'
import TopBar from '../components/TopBar'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
  tosAcceptanceRequired: boolean
  hideFromRanking: boolean
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
  useTosGate(me)

  const [hideFromRanking, setHideFromRanking] = useState(false)
  const [savingRanking, setSavingRanking] = useState(false)
  const [rankingError, setRankingError] = useState<string | null>(null)

  useEffect(() => {
    if (me.data) setHideFromRanking(me.data.hideFromRanking)
  }, [me.data])

  function handleToggleRanking(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.checked
    setHideFromRanking(next)
    setRankingError(null)
    setSavingRanking(true)

    backendFetch('/api/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hideFromRanking: next }),
    })
      .then((res) => {
        if (res.status === 200) {
          setSavingRanking(false)
          return
        }
        setHideFromRanking(!next)
        setRankingError('Could not save preference.')
        setSavingRanking(false)
      })
      .catch(() => {
        setHideFromRanking(!next)
        setRankingError('Could not save preference.')
        setSavingRanking(false)
      })
  }

  if (me.loading) return <p className="state-message">Loading...</p>
  if (me.error) return <p className="state-message">Something went wrong loading your dashboard.</p>
  if (!me.data) return null

  return (
    <div className="page">
      <TopBar location="dashboard" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content">
        <div>
          <h1 className="page-title">Welcome, {me.data.username}</h1>
          <p className="page-subtitle">Pick a challenge, submit your API&apos;s URL, watch the checks run.</p>
        </div>

        <div>
          <p className="section-label" style={{ marginBottom: 'var(--space-3)' }}>
            Challenges
          </p>
          {challenges.loading && <p className="muted">Loading challenges...</p>}
          {challenges.error && <p className="form-error">Could not load challenges.</p>}
          {challenges.data && (
            <ul className="challenge-list">
              {challenges.data.map((challenge) => (
                <li key={challenge.id}>
                  <a className="challenge-row" href={`/challenges/${challenge.id}`}>
                    <span className="challenge-row-title">{challenge.title}</span>
                    <span className="challenge-row-meta">
                      <span className="badge-category">{challenge.category}</span>
                      <span className="challenge-row-points">{challenge.points} pts</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <label className="field-checkbox">
            <input
              type="checkbox"
              checked={hideFromRanking}
              onChange={handleToggleRanking}
              disabled={savingRanking}
            />
            Hide from public ranking
          </label>
          {rankingError && <p className="form-error">{rankingError}</p>}
        </div>
      </div>
    </div>
  )
}
```

Modify `frontend/app/components/TopBar.tsx` — add a "Ranking" link inside `.topbar-brand`, right after the `location` span, visible regardless of login state:

```tsx
export default function TopBar({ location, username, isAdmin }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <a href="/dashboard" style={{ color: 'inherit', textDecoration: 'none' }}>
          <span className="topbar-prompt">&gt;</span> practice
        </a>
        {location && <span className="topbar-location">{location}</span>}
        <a href="/ranking" className="topbar-location" style={{ textDecoration: 'none' }}>
          Ranking
        </a>
      </div>
      {username && (
        <div className="topbar-user">
          {isAdmin && (
            <>
              <span className="topbar-admin-tag">admin</span>
              <a href="/admin/llm-settings">LLM</a>
              <a href="/admin/tos">ToS</a>
            </>
          )}
          <span>{username}</span>
          <a href={`${process.env.NEXT_PUBLIC_BACKEND_URL}/auth/logout`}>Logout</a>
        </div>
      )}
    </header>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test -- dashboard.test.tsx`
Expected: PASS (all tests in the file, old and new)

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test`
Expected: PASS (all suites — confirms the `TopBar` change didn't break any other page's snapshot/assertions)

- [ ] **Step 6: Commit**

```bash
git add frontend/app/dashboard/page.tsx frontend/app/components/TopBar.tsx frontend/tests/dashboard.test.tsx
git commit -m "feat: add ranking opt-out toggle and TopBar Ranking link"
```
