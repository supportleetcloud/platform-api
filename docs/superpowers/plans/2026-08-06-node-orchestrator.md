# Node Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Node backend to the already-built Java validation engine so a logged-in user can browse a challenge catalog, submit their API's URL, and see the score — with free-tier attempt limits enforced and the engine's webhook callback authenticated.

**Architecture:** Thin orchestrator on top of the existing Express/Prisma backend. `POST /api/runs` validates the request, enforces free-tier gating, persists a `Run` row, and calls the Java engine's `POST /runs` (fire-and-accept — the engine responds immediately and works in the background). The engine `POST`s the result back to a per-job, token-authenticated webhook URL Node constructs (`POST /api/webhooks/runs/:jobId?token=...`), which updates the `Run` row. The frontend polls `GET /api/runs/:id`. No queue/broker, no changes to the Java module.

**Tech Stack:** Node.js 20 + TypeScript, Express, Prisma (Postgres), Jest + Supertest (existing conventions from the Foundation plan). `js-yaml` (new) for parsing challenge metadata at seed time. Node's built-in global `fetch` for calling the validation engine — no new HTTP client library.

## Global Constraints

- No queue/broker (Redis, BullMQ, SQS) between Node and Java — webhook push only (`PLANO_MVP.md`, "Arquitetura técnica"; design spec "Architecture").
- Zero changes to the `validation-engine` (Java) module — this plan integrates with its existing `POST /runs` request/response and webhook-push contract as-is (design spec scope).
- Free tier: 2 challenges auto-locked on first attempt, 10 attempts each (`PLANO_MVP.md`, "Monetização") — gated on a new `User.isPaid` boolean that stays `false` for everyone until a future billing plan flips it via Stripe. Nothing in this plan reads or writes Stripe.
- Out of scope for this plan: admin panel, AI feedback engine, ranking/public profile, rate limiting on submission, and any hosting/deploy/Docker Compose changes (design spec scope).
- Challenge YAML lives as static files in `backend/challenges/`, not editable via any admin UI in this plan.
- Code style follows the existing `backend/` conventions exactly: no semicolons, single quotes, 2-space indent, dependencies injected into `createApp(deps)` and threaded down through router-factory functions (not global singletons), tests run against a real Postgres test database via Prisma (no mocking the DB).

---

## Task 1: Challenge data model + seed script

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/challenges/todo-api-crud.yaml`
- Create: `backend/challenges/todo-api-contract.yaml`
- Create: `backend/challenges/status-headers-basics.yaml`
- Create: `backend/challenges/jwt-auth-basics.yaml`
- Create: `backend/src/challenges/service.ts`
- Create: `backend/scripts/seed-challenges.ts`
- Modify: `backend/package.json`
- Test: `backend/tests/challenges.service.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks in this plan.
- Produces: `CHALLENGES_DIR: string`, `ParsedChallengeYaml { id: string; title: string; category: string; checks: { points: number }[] }`, `parseChallengeYaml(yamlText: string): ParsedChallengeYaml`, `sumPoints(checks: { points: number }[]): number`, `seedChallengesFromDirectory(prisma: PrismaClient, challengesDir: string): Promise<void>` — all from `backend/src/challenges/service.ts`. The `Challenge` Prisma model (`id, title, category, points, yamlPath, createdAt`) — used by Task 2 (catalog routes), Task 3 (`submitRun` reads `challenge.yamlPath` off `CHALLENGES_DIR`), Task 6 (e2e test).

- [ ] **Step 1: Add the YAML parsing dependency**

Run: `cd backend && npm install js-yaml && npm install -D @types/js-yaml`

- [ ] **Step 2: Add the `Challenge` model and migrate**

Modify `backend/prisma/schema.prisma` — append after the existing `User` model:

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
}
```

Run: `cd backend && npx prisma migrate dev --name add_challenge`
(Then apply the same migration to the test database: `DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npx prisma migrate deploy`, matching the README's existing test-DB setup step.)

- [ ] **Step 3: Add the four fixture challenge YAML files**

These reuse the exact category fixtures the `validation-engine`'s own test suite already proves end-to-end (`validation-engine/src/test/resources/challenges/`) — one per v1 category. Real launch-content curation beyond these four is future work (flagged in the design spec's Open Items); these exist to prove the orchestration pipeline, not to be the final catalog.

Create `backend/challenges/todo-api-crud.yaml`:

```yaml
id: todo-api-crud
title: "Build a Todo CRUD API"
category: crud
checks:
  - name: "POST /todos creates a todo"
    request:
      method: POST
      path: /todos
      headers:
        Content-Type: application/json
      body:
        title: "Buy milk"
    expect:
      status: 201
      json:
        title: "Buy milk"
        completed: false
      headers:
        Location: exists
    points: 10

  - name: "GET /todos/{id} returns the created todo"
    request:
      method: GET
      path: "/todos/{{steps[0].response.json.id}}"
    expect:
      status: 200
      json:
        title: "Buy milk"
    points: 10

  - name: "DELETE /todos/{id} removes it"
    request:
      method: DELETE
      path: "/todos/{{steps[0].response.json.id}}"
    expect:
      status: 204
    points: 5
```

Create `backend/challenges/todo-api-contract.yaml`:

```yaml
id: todo-api-contract
title: "Todo API conforms to its OpenAPI contract"
category: contract
openapiSpec: openapi/todo-api.yaml
checks:
  - name: "POST /todos response matches OpenAPI spec"
    request:
      method: POST
      path: /todos
      headers:
        Content-Type: application/json
      body:
        title: "Buy milk"
    expect:
      status: 201
      matchesOpenApi: true
    points: 10
```

> This challenge's `matchesOpenApi` check needs `openapi/todo-api.yaml` on the validation engine's classpath. Today that file only exists under `validation-engine/src/test/resources/`, not `src/main/resources/` — submitting this challenge against a real running engine (outside its own test suite) will error on that one check until it's copied over. That copy is explicitly out of scope here (tracked in the design spec's Open Items) — this task only needs the file to exist so the catalog/seed code has something real to parse; Task 6's e2e test doesn't exercise this particular challenge.

Create `backend/challenges/status-headers-basics.yaml`:

```yaml
id: status-headers-basics
title: "Status codes and headers"
category: status
checks:
  - name: "GET /health returns 200 with expected headers"
    request:
      method: GET
      path: /health
    expect:
      status: 200
      headers:
        X-Service: "todo-api"
        Content-Type: "regex:application/json.*"
    points: 10
  - name: "GET /missing returns 404"
    request:
      method: GET
      path: /missing
    expect:
      status: 404
    points: 5
```

Create `backend/challenges/jwt-auth-basics.yaml`:

```yaml
id: jwt-auth-basics
title: "JWT-protected profile endpoint"
category: auth
checks:
  - name: "POST /login returns a token"
    request:
      method: POST
      path: /login
      body: { username: "test-user", password: "test-pass" }
    expect:
      status: 200
      json: { token: exists }
    points: 5

  - name: "GET /profile with valid token succeeds"
    request:
      method: GET
      path: /profile
      headers:
        Authorization: "Bearer {{steps[0].response.json.token}}"
    expect:
      status: 200
      jwtClaims:
        sub: exists
    points: 10

  - name: "GET /profile with no token is rejected"
    request:
      method: GET
      path: /profile
    expect:
      status: 401
    points: 5

  - name: "GET /profile with malformed token is rejected"
    request:
      method: GET
      path: /profile
      headers:
        Authorization: "Bearer not-a-real-token"
    expect:
      status: 401
    points: 5
```

- [ ] **Step 4: Write the failing test for parsing and seeding**

Create `backend/tests/challenges.service.test.ts`:

```ts
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { PrismaClient } from '@prisma/client'
import {
  parseChallengeYaml,
  sumPoints,
  seedChallengesFromDirectory,
} from '../src/challenges/service'

const prisma = new PrismaClient()

const FIXTURE_YAML = `
id: fixture-challenge
title: "Fixture Challenge"
category: crud
checks:
  - name: "step one"
    request:
      method: GET
      path: /ping
    expect:
      status: 200
    points: 10
  - name: "step two"
    request:
      method: GET
      path: /pong
    expect:
      status: 200
    points: 15
`

describe('parseChallengeYaml / sumPoints', () => {
  it('parses id/title/category/checks and sums points', () => {
    const parsed = parseChallengeYaml(FIXTURE_YAML)
    expect(parsed.id).toBe('fixture-challenge')
    expect(parsed.title).toBe('Fixture Challenge')
    expect(parsed.category).toBe('crud')
    expect(sumPoints(parsed.checks)).toBe(25)
  })
})

describe('seedChallengesFromDirectory', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenges-test-'))
    fs.writeFileSync(path.join(dir, 'fixture-challenge.yaml'), FIXTURE_YAML)
  })

  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true })
    await prisma.challenge.deleteMany({ where: { id: 'fixture-challenge' } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('upserts a Challenge row per YAML file', async () => {
    await seedChallengesFromDirectory(prisma, dir)

    const challenge = await prisma.challenge.findUnique({ where: { id: 'fixture-challenge' } })
    expect(challenge).not.toBeNull()
    expect(challenge?.title).toBe('Fixture Challenge')
    expect(challenge?.category).toBe('crud')
    expect(challenge?.points).toBe(25)
    expect(challenge?.yamlPath).toBe('fixture-challenge.yaml')
  })

  it('is idempotent — re-running does not duplicate or error', async () => {
    await seedChallengesFromDirectory(prisma, dir)
    await seedChallengesFromDirectory(prisma, dir)

    const count = await prisma.challenge.count({ where: { id: 'fixture-challenge' } })
    expect(count).toBe(1)
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- challenges.service.test.ts`
Expected: FAIL — `Cannot find module '../src/challenges/service'`

- [ ] **Step 6: Implement the challenges service**

Create `backend/src/challenges/service.ts`:

```ts
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { PrismaClient } from '@prisma/client'

export const CHALLENGES_DIR = path.join(__dirname, '..', '..', 'challenges')

export type ChallengeCheckSpec = {
  points: number
}

export type ParsedChallengeYaml = {
  id: string
  title: string
  category: string
  checks: ChallengeCheckSpec[]
}

export function parseChallengeYaml(yamlText: string): ParsedChallengeYaml {
  return yaml.load(yamlText) as ParsedChallengeYaml
}

export function sumPoints(checks: ChallengeCheckSpec[]): number {
  return checks.reduce((total, check) => total + check.points, 0)
}

export async function seedChallengesFromDirectory(
  prisma: PrismaClient,
  challengesDir: string
): Promise<void> {
  const files = fs.readdirSync(challengesDir).filter((file) => file.endsWith('.yaml'))

  for (const file of files) {
    const yamlText = fs.readFileSync(path.join(challengesDir, file), 'utf-8')
    const parsed = parseChallengeYaml(yamlText)
    const points = sumPoints(parsed.checks)

    await prisma.challenge.upsert({
      where: { id: parsed.id },
      update: { title: parsed.title, category: parsed.category, points, yamlPath: file },
      create: { id: parsed.id, title: parsed.title, category: parsed.category, points, yamlPath: file },
    })
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- challenges.service.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 8: Add the seed script and npm script**

Create `backend/scripts/seed-challenges.ts`:

```ts
import 'dotenv/config'
import { prisma } from '../src/db/client'
import { CHALLENGES_DIR, seedChallengesFromDirectory } from '../src/challenges/service'

seedChallengesFromDirectory(prisma, CHALLENGES_DIR)
  .then(async () => {
    console.log('Challenges seeded.')
    await prisma.$disconnect()
  })
  .catch(async (err) => {
    console.error('Failed to seed challenges:', err)
    await prisma.$disconnect()
    process.exit(1)
  })
```

Modify `backend/package.json` — add `ts-node` as a devDependency (needed to run the one-off script directly; `ts-node-dev` is for the long-running dev server) and a `seed:challenges` script:

```bash
cd backend && npm install -D ts-node
```

Then add to the `"scripts"` block:

```json
"seed:challenges": "ts-node scripts/seed-challenges.ts",
```

- [ ] **Step 9: Run the seed script against the dev database and verify**

Run: `cd backend && npm run seed:challenges`
Expected: prints `Challenges seeded.`; `npx prisma studio` (or `psql`) shows 4 rows in `Challenge`.

- [ ] **Step 10: Commit**

```bash
git add backend/prisma backend/challenges backend/src/challenges backend/scripts backend/package.json backend/package-lock.json backend/tests/challenges.service.test.ts
git commit -m "feat: add Challenge model, launch-fixture YAML, and seed script"
```

---

## Task 2: Challenge catalog API

**Files:**
- Create: `backend/src/challenges/routes.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/tests/challenges.routes.test.ts`

**Interfaces:**
- Consumes: `Challenge` Prisma model (Task 1).
- Produces: `createChallengesRouter(prisma: PrismaClient): Router` from `backend/src/challenges/routes.ts`, mounted at root, exposing `GET /api/challenges` and `GET /api/challenges/:id` — used by Task 6's e2e test and the frontend (out of scope here).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/challenges.routes.test.ts`:

```ts
import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

const prisma = new PrismaClient()

describe('Challenge catalog routes', () => {
  beforeAll(async () => {
    await prisma.challenge.upsert({
      where: { id: 'catalog-test-challenge' },
      update: {},
      create: {
        id: 'catalog-test-challenge',
        title: 'Catalog Test Challenge',
        category: 'crud',
        points: 20,
        yamlPath: 'catalog-test-challenge.yaml',
      },
    })
  })

  afterAll(async () => {
    await prisma.challenge.delete({ where: { id: 'catalog-test-challenge' } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('GET /api/challenges lists metadata without the yaml path', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges')

    expect(res.status).toBe(200)
    const entry = res.body.find((c: any) => c.id === 'catalog-test-challenge')
    expect(entry).toEqual({
      id: 'catalog-test-challenge',
      title: 'Catalog Test Challenge',
      category: 'crud',
      points: 20,
    })
  })

  it('GET /api/challenges/:id returns one challenge', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges/catalog-test-challenge')

    expect(res.status).toBe(200)
    expect(res.body.title).toBe('Catalog Test Challenge')
  })

  it('GET /api/challenges/:id returns 404 for an unknown id', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/challenges/does-not-exist')

    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- challenges.routes.test.ts`
Expected: FAIL — `GET /api/challenges` 404s (route doesn't exist yet)

- [ ] **Step 3: Implement the catalog router**

Create `backend/src/challenges/routes.ts`:

```ts
import { Router } from 'express'
import { PrismaClient } from '@prisma/client'

export function createChallengesRouter(prisma: PrismaClient): Router {
  const router = Router()

  router.get('/api/challenges', async (_req, res) => {
    const challenges = await prisma.challenge.findMany({
      select: { id: true, title: true, category: true, points: true },
      orderBy: { createdAt: 'asc' },
    })
    res.json(challenges)
  })

  router.get('/api/challenges/:id', async (req, res) => {
    const challenge = await prisma.challenge.findUnique({
      where: { id: req.params.id },
      select: { id: true, title: true, category: true, points: true },
    })

    if (!challenge) {
      res.status(404).json({ error: 'challenge_not_found' })
      return
    }

    res.json(challenge)
  })

  return router
}
```

- [ ] **Step 4: Wire the router into `createApp`**

Modify `backend/src/app.ts` — add the import alongside the existing router imports:

```ts
import { meRouter } from './users/routes'
import { createChallengesRouter } from './challenges/routes'
```

And mount it alongside the existing routers (right after `app.use(meRouter)`):

```ts
  app.use(authRouter)
  app.use(meRouter)
  app.use(createChallengesRouter(prisma))
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- challenges.routes.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/src/challenges/routes.ts backend/src/app.ts backend/tests/challenges.routes.test.ts
git commit -m "feat: expose GET /api/challenges list and detail routes"
```

---

## Task 3: Run submission (`POST /api/runs`)

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/src/runs/service.ts`
- Create: `backend/src/runs/routes.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/.env.example`
- Test: `backend/tests/runs.routes.test.ts`

**Interfaces:**
- Consumes: `CHALLENGES_DIR` (Task 1, `backend/src/challenges/service.ts`), `Challenge` Prisma model (Task 1).
- Produces: `RunsServiceConfig { validationEngineUrl: string; webhookBaseUrl: string }`, `SubmitRunInput { userId: string; challengeId: string; targetUrl: string; confirmedAuthorization: boolean }`, `SubmitRunResult = { kind: 'accepted'; runId: string } | { kind: 'validation_error'; error: string } | { kind: 'free_tier_limit'; error: string } | { kind: 'engine_unreachable'; runId: string; error: string }`, `submitRun(prisma, fetchImpl, config, input): Promise<SubmitRunResult>` from `backend/src/runs/service.ts`. `createRunsRouter(prisma, fetchImpl, config): Router`, `RunsRouterConfig` from `backend/src/runs/routes.ts`, mounted at root exposing `POST /api/runs`. The `Run` Prisma model (`id, userId, challengeId, targetUrl, status, score, checks, error, callbackToken, createdAt, updatedAt`) and `User.isPaid` — used by Task 4 (webhook needs `Run` + `callbackToken`), Task 5 (adds `getRun`/GET handler to these same files), Task 6.

- [ ] **Step 1: Add the `Run` model, `User.isPaid`, and migrate**

Modify `backend/prisma/schema.prisma` — replace the existing `User` model with (adds `isPaid` and the `runs` back-relation):

```prisma
model User {
  id        String   @id @default(uuid())
  githubId  String   @unique
  username  String
  avatarUrl String?
  isAdmin   Boolean  @default(false)
  isPaid    Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  runs Run[]
}
```

Append after the `Challenge` model:

```prisma
model Run {
  id            String   @id @default(uuid())
  userId        String
  challengeId   String
  targetUrl     String
  status        String   @default("pending")
  score         Int?
  checks        Json?
  error         String?
  callbackToken String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user      User      @relation(fields: [userId], references: [id])
  challenge Challenge @relation(fields: [challengeId], references: [id])

  @@index([userId, challengeId])
}
```

Also add the matching back-relation to `Challenge` (append `runs Run[]` inside the model block from Task 1):

```prisma
model Challenge {
  id        String   @id
  title     String
  category  String
  points    Int
  yamlPath  String
  createdAt DateTime @default(now())

  runs Run[]
}
```

Run: `cd backend && npx prisma migrate dev --name add_run_and_user_ispaid`
(Then: `DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npx prisma migrate deploy`)

- [ ] **Step 2: Add the new env vars**

Modify `backend/.env.example` — add after `PORT`:

```
VALIDATION_ENGINE_URL="http://localhost:8080"
WEBHOOK_BASE_URL="http://localhost:4000"
```

- [ ] **Step 3: Write the failing test**

Create `backend/tests/runs.routes.test.ts`:

```ts
import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

jest.mock('passport', () => {
  const actual = jest.requireActual('passport')
  const originalAuthenticate = actual.authenticate.bind(actual)
  return Object.assign(actual, {
    authenticate: (strategy: string, ...args: any[]) => {
      if (strategy === 'session') {
        return originalAuthenticate(strategy, ...args)
      }
      return (req: any, _res: any, next: any) => {
        req.user = { id: TEST_USER_ID, username: 'octocat', avatarUrl: null, isAdmin: false }
        req.login(req.user, (err: Error) => next(err))
      }
    },
  })
})

const TEST_USER_ID = 'runs-routes-test-user'
const CHALLENGE_ID = 'runs-routes-test-challenge'
const prisma = new PrismaClient()

describe('POST /api/runs', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: { isPaid: false },
      create: { id: TEST_USER_ID, githubId: 'gh-runs-routes-test', username: 'octocat', isPaid: false },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_ID },
      update: {},
      create: {
        id: CHALLENGE_ID,
        title: 'Todo CRUD',
        category: 'crud',
        points: 25,
        yamlPath: 'todo-api-crud.yaml',
      },
    })
  })

  beforeEach(async () => {
    await prisma.run.deleteMany({ where: { userId: TEST_USER_ID } })
  })

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId: TEST_USER_ID } })
    await prisma.challenge.delete({ where: { id: CHALLENGE_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('returns 401 when not authenticated', async () => {
    const app = createApp({ prisma, fetchImpl: jest.fn() as any })
    const res = await request(app).post('/api/runs').send({})
    expect(res.status).toBe(401)
  })

  it('accepts a valid submission and persists a pending Run', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 202 }) as any
    const app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/runs').send({
      challengeId: CHALLENGE_ID,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })

    expect(res.status).toBe(202)
    expect(res.body.status).toBe('pending')

    const run = await prisma.run.findUnique({ where: { id: res.body.runId } })
    expect(run).not.toBeNull()
    expect(run?.status).toBe('pending')
    expect(run?.targetUrl).toBe('https://candidate.example.com')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://validation-engine.test/runs')
    const sentBody = JSON.parse(options.body)
    expect(sentBody.targetUrl).toBe('https://candidate.example.com')
    expect(sentBody.webhookUrl).toContain(`/api/webhooks/runs/${res.body.runId}?token=`)
  })

  it('rejects without confirmedAuthorization', async () => {
    const app = createApp({ prisma, fetchImpl: jest.fn() as any })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/runs').send({
      challengeId: CHALLENGE_ID,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: false,
    })

    expect(res.status).toBe(400)
  })

  it('returns 502 and marks the Run errored when the validation engine is unreachable', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as any
    const app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/runs').send({
      challengeId: CHALLENGE_ID,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })

    expect(res.status).toBe(502)

    const run = await prisma.run.findFirst({
      where: { userId: TEST_USER_ID },
      orderBy: { createdAt: 'desc' },
    })
    expect(run?.status).toBe('error')
    expect(run?.error).toBe('failed to reach validation engine')
  })

  it('returns 500 when the challenge YAML file is missing on disk', async () => {
    const brokenChallengeId = 'runs-routes-test-broken-challenge'
    await prisma.challenge.upsert({
      where: { id: brokenChallengeId },
      update: {},
      create: {
        id: brokenChallengeId,
        title: 'Broken',
        category: 'crud',
        points: 10,
        yamlPath: 'does-not-exist.yaml',
      },
    })

    const fetchImpl = jest.fn() as any
    const app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/runs').send({
      challengeId: brokenChallengeId,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })

    expect(res.status).toBe(500)
    expect(fetchImpl).not.toHaveBeenCalled()

    await prisma.challenge.delete({ where: { id: brokenChallengeId } }).catch(() => {})
  })

  it('blocks a 3rd distinct free-tier challenge', async () => {
    const otherChallengeA = 'runs-routes-test-challenge-a'
    const otherChallengeB = 'runs-routes-test-challenge-b'
    await prisma.challenge.upsert({
      where: { id: otherChallengeA },
      update: {},
      create: { id: otherChallengeA, title: 'A', category: 'crud', points: 10, yamlPath: 'todo-api-crud.yaml' },
    })
    await prisma.challenge.upsert({
      where: { id: otherChallengeB },
      update: {},
      create: { id: otherChallengeB, title: 'B', category: 'crud', points: 10, yamlPath: 'todo-api-crud.yaml' },
    })

    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 202 }) as any
    const app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    await agent.post('/api/runs').send({
      challengeId: CHALLENGE_ID,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })
    await agent.post('/api/runs').send({
      challengeId: otherChallengeA,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })
    const res = await agent.post('/api/runs').send({
      challengeId: otherChallengeB,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })

    expect(res.status).toBe(403)

    await prisma.challenge.delete({ where: { id: otherChallengeA } }).catch(() => {})
    await prisma.challenge.delete({ where: { id: otherChallengeB } }).catch(() => {})
  })

  it('blocks an 11th attempt on the same free-tier challenge', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 202 }) as any
    const app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    for (let i = 0; i < 10; i++) {
      const res = await agent.post('/api/runs').send({
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        confirmedAuthorization: true,
      })
      expect(res.status).toBe(202)
    }

    const res = await agent.post('/api/runs').send({
      challengeId: CHALLENGE_ID,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- runs.routes.test.ts`
Expected: FAIL — `Cannot find module '../src/runs/service'` (or similar, since neither file exists yet)

- [ ] **Step 5: Implement the run submission service**

Create `backend/src/runs/service.ts`:

```ts
import { PrismaClient } from '@prisma/client'
import { randomUUID, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { CHALLENGES_DIR } from '../challenges/service'

const FREE_TIER_CHALLENGE_LIMIT = 2
const FREE_TIER_ATTEMPT_LIMIT = 10

export type RunsServiceConfig = {
  validationEngineUrl: string
  webhookBaseUrl: string
}

export type SubmitRunInput = {
  userId: string
  challengeId: string
  targetUrl: string
  confirmedAuthorization: boolean
}

export type SubmitRunResult =
  | { kind: 'accepted'; runId: string }
  | { kind: 'validation_error'; error: string }
  | { kind: 'free_tier_limit'; error: string }
  | { kind: 'engine_unreachable'; runId: string; error: string }
  | { kind: 'internal_error'; error: string }

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

async function freeTierLimitError(
  prisma: PrismaClient,
  userId: string,
  challengeId: string
): Promise<string | null> {
  const attempted = await prisma.run.findMany({
    where: { userId },
    distinct: ['challengeId'],
    select: { challengeId: true },
  })
  const attemptedIds = attempted.map((run) => run.challengeId)

  if (!attemptedIds.includes(challengeId) && attemptedIds.length >= FREE_TIER_CHALLENGE_LIMIT) {
    return `free tier is limited to ${FREE_TIER_CHALLENGE_LIMIT} challenges`
  }

  const attemptCount = await prisma.run.count({ where: { userId, challengeId } })
  if (attemptCount >= FREE_TIER_ATTEMPT_LIMIT) {
    return `free tier is limited to ${FREE_TIER_ATTEMPT_LIMIT} attempts per challenge`
  }

  return null
}

export async function submitRun(
  prisma: PrismaClient,
  fetchImpl: typeof fetch,
  config: RunsServiceConfig,
  input: SubmitRunInput
): Promise<SubmitRunResult> {
  if (input.confirmedAuthorization !== true) {
    return { kind: 'validation_error', error: 'confirmedAuthorization must be true' }
  }
  if (!isHttpUrl(input.targetUrl)) {
    return { kind: 'validation_error', error: 'targetUrl must be a valid http(s) URL' }
  }

  const challenge = await prisma.challenge.findUnique({ where: { id: input.challengeId } })
  if (!challenge) {
    return { kind: 'validation_error', error: 'challenge not found' }
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId } })
  if (!user.isPaid) {
    const gateError = await freeTierLimitError(prisma, input.userId, input.challengeId)
    if (gateError) {
      return { kind: 'free_tier_limit', error: gateError }
    }
  }

  let challengeYaml: string
  try {
    challengeYaml = fs.readFileSync(path.join(CHALLENGES_DIR, challenge.yamlPath), 'utf-8')
  } catch (err) {
    console.error(`Failed to read challenge YAML for ${challenge.id} at ${challenge.yamlPath}:`, err)
    return { kind: 'internal_error', error: 'failed to load challenge definition' }
  }

  const jobId = randomUUID()
  const callbackToken = randomBytes(24).toString('hex')

  await prisma.run.create({
    data: {
      id: jobId,
      userId: input.userId,
      challengeId: input.challengeId,
      targetUrl: input.targetUrl,
      status: 'pending',
      callbackToken,
    },
  })

  const webhookUrl = `${config.webhookBaseUrl}/api/webhooks/runs/${jobId}?token=${callbackToken}`

  try {
    const response = await fetchImpl(`${config.validationEngineUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, targetUrl: input.targetUrl, challengeYaml, webhookUrl }),
    })
    if (!response.ok) {
      throw new Error(`validation engine responded ${response.status}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    await prisma.run.update({
      where: { id: jobId },
      data: { status: 'error', error: 'failed to reach validation engine' },
    })
    return { kind: 'engine_unreachable', runId: jobId, error: message }
  }

  return { kind: 'accepted', runId: jobId }
}
```

- [ ] **Step 6: Implement the runs router**

Create `backend/src/runs/routes.ts`:

```ts
import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { requireAuth } from '../auth/middleware'
import { submitRun, RunsServiceConfig } from './service'

export type RunsRouterConfig = RunsServiceConfig

export function createRunsRouter(
  prisma: PrismaClient,
  fetchImpl: typeof fetch,
  config: RunsRouterConfig
): Router {
  const router = Router()

  router.post('/api/runs', requireAuth, async (req, res) => {
    const user = req.user as { id: string }
    const body = req.body ?? {}

    const result = await submitRun(prisma, fetchImpl, config, {
      userId: user.id,
      challengeId: body.challengeId,
      targetUrl: body.targetUrl,
      confirmedAuthorization: body.confirmedAuthorization === true,
    })

    if (result.kind === 'accepted') {
      res.status(202).json({ runId: result.runId, status: 'pending' })
      return
    }
    if (result.kind === 'validation_error') {
      res.status(400).json({ error: result.error })
      return
    }
    if (result.kind === 'free_tier_limit') {
      res.status(403).json({ error: result.error })
      return
    }
    if (result.kind === 'internal_error') {
      res.status(500).json({ error: result.error })
      return
    }
    res.status(502).json({ error: result.error })
  })

  return router
}
```

- [ ] **Step 7: Wire the router into `createApp`, inject `fetchImpl`**

Modify `backend/src/app.ts` — add the import:

```ts
import { createChallengesRouter } from './challenges/routes'
import { createRunsRouter } from './runs/routes'
```

Change the `createApp` signature and the top of its body to accept and default `fetchImpl`:

```ts
export function createApp(deps: { prisma?: PrismaClient; fetchImpl?: typeof fetch } = {}) {
  const prisma = deps.prisma ?? defaultPrisma
  const fetchImpl = deps.fetchImpl ?? fetch
  const app = express()
```

Add the engine config, read from env, right before the router mounting section:

```ts
  const validationEngineUrl = process.env.VALIDATION_ENGINE_URL ?? 'http://localhost:8080'
  const webhookBaseUrl = process.env.WEBHOOK_BASE_URL ?? 'http://localhost:4000'
```

And mount the runs router alongside the others:

```ts
  app.use(authRouter)
  app.use(meRouter)
  app.use(createChallengesRouter(prisma))
  app.use(createRunsRouter(prisma, fetchImpl, { validationEngineUrl, webhookBaseUrl }))
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- runs.routes.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 9: Commit**

```bash
git add backend/prisma backend/.env.example backend/src/runs backend/src/app.ts backend/tests/runs.routes.test.ts
git commit -m "feat: submit challenge runs to the validation engine with free-tier gating"
```

---

## Task 4: Webhook receiver (`POST /api/webhooks/runs/:jobId`)

**Files:**
- Create: `backend/src/runs/webhook.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/tests/runs.webhook.test.ts`

**Interfaces:**
- Consumes: `Run` Prisma model + `callbackToken` field (Task 3).
- Produces: `createRunsWebhookRouter(prisma: PrismaClient): Router` from `backend/src/runs/webhook.ts`, mounted at root exposing `POST /api/webhooks/runs/:jobId` — used by Task 6's e2e test (and, in production, the validation engine's `WebhookNotifier`).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/runs.webhook.test.ts`:

```ts
import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

const prisma = new PrismaClient()
const TEST_USER_ID = 'webhook-test-user'
const CHALLENGE_ID = 'webhook-test-challenge'

async function createPendingRun(id: string, token: string) {
  return prisma.run.create({
    data: {
      id,
      userId: TEST_USER_ID,
      challengeId: CHALLENGE_ID,
      targetUrl: 'https://candidate.example.com',
      status: 'pending',
      callbackToken: token,
    },
  })
}

describe('POST /api/webhooks/runs/:jobId', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, githubId: 'gh-webhook-test', username: 'octocat' },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_ID },
      update: {},
      create: { id: CHALLENGE_ID, title: 'Webhook Test', category: 'crud', points: 10, yamlPath: 'todo-api-crud.yaml' },
    })
  })

  afterEach(async () => {
    await prisma.run.deleteMany({ where: { userId: TEST_USER_ID } })
  })

  afterAll(async () => {
    await prisma.challenge.delete({ where: { id: CHALLENGE_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('returns 404 for an unknown jobId', async () => {
    const app = createApp({ prisma })
    const res = await request(app)
      .post('/api/webhooks/runs/does-not-exist?token=x')
      .send({ status: 'completed' })
    expect(res.status).toBe(404)
  })

  it('returns 403 when the token does not match, and leaves the Run untouched', async () => {
    await createPendingRun('webhook-test-run-1', 'correct-token')
    const app = createApp({ prisma })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-1?token=wrong-token')
      .send({ status: 'completed', score: 100, checks: [] })

    expect(res.status).toBe(403)

    const run = await prisma.run.findUnique({ where: { id: 'webhook-test-run-1' } })
    expect(run?.status).toBe('pending')
  })

  it('updates the Run to completed with the correct token', async () => {
    await createPendingRun('webhook-test-run-2', 'correct-token')
    const app = createApp({ prisma })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-2?token=correct-token')
      .send({
        status: 'completed',
        score: 85,
        checks: [{ name: 'check', status: 'passed', points: 10, pointsEarned: 10, assertions: [] }],
      })

    expect(res.status).toBe(200)

    const run = await prisma.run.findUnique({ where: { id: 'webhook-test-run-2' } })
    expect(run?.status).toBe('completed')
    expect(run?.score).toBe(85)
    expect(run?.checks).toEqual([
      { name: 'check', status: 'passed', points: 10, pointsEarned: 10, assertions: [] },
    ])
  })

  it('updates the Run to error with the error message', async () => {
    await createPendingRun('webhook-test-run-3', 'correct-token')
    const app = createApp({ prisma })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-3?token=correct-token')
      .send({ status: 'error', error: 'challenge YAML failed to parse' })

    expect(res.status).toBe(200)

    const run = await prisma.run.findUnique({ where: { id: 'webhook-test-run-3' } })
    expect(run?.status).toBe('error')
    expect(run?.error).toBe('challenge YAML failed to parse')
  })

  it('is idempotent — a second callback for an already-resolved run is a no-op', async () => {
    await createPendingRun('webhook-test-run-4', 'correct-token')
    const app = createApp({ prisma })

    await request(app)
      .post('/api/webhooks/runs/webhook-test-run-4?token=correct-token')
      .send({ status: 'completed', score: 50, checks: [] })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-4?token=correct-token')
      .send({ status: 'error', error: 'should not overwrite' })

    expect(res.status).toBe(200)

    const run = await prisma.run.findUnique({ where: { id: 'webhook-test-run-4' } })
    expect(run?.status).toBe('completed')
    expect(run?.score).toBe(50)
  })

  it('rejects an invalid status value', async () => {
    await createPendingRun('webhook-test-run-5', 'correct-token')
    const app = createApp({ prisma })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-5?token=correct-token')
      .send({ status: 'bogus' })

    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- runs.webhook.test.ts`
Expected: FAIL — `Cannot find module '../src/runs/webhook'`

- [ ] **Step 3: Implement the webhook router**

Create `backend/src/runs/webhook.ts`:

```ts
import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { timingSafeEqual } from 'crypto'

function tokensMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected)
  const providedBuf = Buffer.from(provided)
  if (expectedBuf.length !== providedBuf.length) {
    return false
  }
  return timingSafeEqual(expectedBuf, providedBuf)
}

export function createRunsWebhookRouter(prisma: PrismaClient): Router {
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
      },
    })

    res.status(200).json({ status: 'ok' })
  })

  return router
}
```

- [ ] **Step 4: Wire the router into `createApp`**

Modify `backend/src/app.ts` — add the import:

```ts
import { createRunsWebhookRouter } from './runs/webhook'
```

And mount it alongside the runs router:

```ts
  app.use(createRunsRouter(prisma, fetchImpl, { validationEngineUrl, webhookBaseUrl }))
  app.use(createRunsWebhookRouter(prisma))
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- runs.webhook.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/src/runs/webhook.ts backend/src/app.ts backend/tests/runs.webhook.test.ts
git commit -m "feat: receive and authenticate validation-engine webhook callbacks"
```

---

## Task 5: Run polling (`GET /api/runs/:id`)

**Files:**
- Modify: `backend/src/runs/service.ts`
- Modify: `backend/src/runs/routes.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/.env.example`
- Modify: `backend/tests/runs.routes.test.ts`

**Interfaces:**
- Consumes: `Run` Prisma model (Task 3), `createRunsRouter` (Task 3).
- Produces: `GetRunInput { runId: string; userId: string }`, `GetRunResult = { kind: 'not_found' } | { kind: 'found'; run: { runId: string; challengeId: string; targetUrl: string; status: string; score: number | null; checks: unknown; error: string | null; createdAt: Date } }`, `getRun(prisma, runTimeoutMs, input): Promise<GetRunResult>` added to `backend/src/runs/service.ts`. `GET /api/runs/:id` added to the same router — used by Task 6's e2e test.

- [ ] **Step 1: Write the failing test**

Modify `backend/tests/runs.routes.test.ts` — append a new `describe` block after the existing `describe('POST /api/runs', ...)` block (reuses the same `jest.mock('passport', ...)`, `TEST_USER_ID`, `CHALLENGE_ID`, and `prisma` already declared at the top of the file):

```ts
describe('GET /api/runs/:id', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, githubId: 'gh-runs-routes-test', username: 'octocat', isPaid: false },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_ID },
      update: {},
      create: { id: CHALLENGE_ID, title: 'Todo CRUD', category: 'crud', points: 25, yamlPath: 'todo-api-crud.yaml' },
    })
  })

  afterEach(async () => {
    await prisma.run.deleteMany({ where: { userId: TEST_USER_ID } })
  })

  it('returns the run to its owner', async () => {
    const run = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 90,
        callbackToken: 'unused',
      },
    })

    const app = createApp({ prisma, fetchImpl: jest.fn() as any })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get(`/api/runs/${run.id}`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('completed')
    expect(res.body.score).toBe(90)
  })

  it('returns 404 for a run owned by someone else', async () => {
    const otherUserId = 'runs-routes-test-other-user'
    await prisma.user.upsert({
      where: { id: otherUserId },
      update: {},
      create: { id: otherUserId, githubId: 'gh-other', username: 'other' },
    })
    const run = await prisma.run.create({
      data: {
        userId: otherUserId,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        callbackToken: 'unused',
      },
    })

    const app = createApp({ prisma, fetchImpl: jest.fn() as any })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get(`/api/runs/${run.id}`)
    expect(res.status).toBe(404)

    await prisma.run.delete({ where: { id: run.id } })
    await prisma.user.delete({ where: { id: otherUserId } })
  })

  it('reports timed_out for a stale pending run without changing the stored status', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000)
    const run = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'pending',
        callbackToken: 'unused',
        createdAt: staleDate,
      },
    })

    const app = createApp({ prisma, fetchImpl: jest.fn() as any })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get(`/api/runs/${run.id}`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('timed_out')

    const stored = await prisma.run.findUnique({ where: { id: run.id } })
    expect(stored?.status).toBe('pending')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- runs.routes.test.ts`
Expected: FAIL — `GET /api/runs/:id` 404s (route doesn't exist yet)

- [ ] **Step 3: Add `getRun` to the runs service**

Modify `backend/src/runs/service.ts` — extend `RunsServiceConfig` and append `getRun`:

```ts
export type RunsServiceConfig = {
  validationEngineUrl: string
  webhookBaseUrl: string
  runTimeoutMs: number
}
```

Append at the end of the file:

```ts
export type GetRunInput = { runId: string; userId: string }

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
      }
    }

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
    },
  }
}
```

- [ ] **Step 4: Add the GET handler to the runs router**

Modify `backend/src/runs/routes.ts` — update the import and add the new route:

```ts
import { submitRun, getRun, RunsServiceConfig } from './service'
```

```ts
  router.get('/api/runs/:id', requireAuth, async (req, res) => {
    const user = req.user as { id: string }
    const result = await getRun(prisma, config.runTimeoutMs, { runId: req.params.id, userId: user.id })

    if (result.kind === 'not_found') {
      res.status(404).json({ error: 'run_not_found' })
      return
    }

    res.status(200).json(result.run)
  })
```

(Add this inside `createRunsRouter`, after the existing `router.post('/api/runs', ...)` block and before `return router`.)

- [ ] **Step 5: Wire `runTimeoutMs` and the new env var**

Modify `backend/.env.example` — add after `WEBHOOK_BASE_URL`:

```
RUN_TIMEOUT_MS="300000"
```

Modify `backend/src/app.ts` — add alongside the other engine config:

```ts
  const validationEngineUrl = process.env.VALIDATION_ENGINE_URL ?? 'http://localhost:8080'
  const webhookBaseUrl = process.env.WEBHOOK_BASE_URL ?? 'http://localhost:4000'
  const runTimeoutMs = Number(process.env.RUN_TIMEOUT_MS ?? 300000)
```

And update the router mount line to pass it through:

```ts
  app.use(createRunsRouter(prisma, fetchImpl, { validationEngineUrl, webhookBaseUrl, runTimeoutMs }))
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- runs.routes.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 7: Commit**

```bash
git add backend/src/runs backend/src/app.ts backend/.env.example backend/tests/runs.routes.test.ts
git commit -m "feat: poll run status with owner check and stale-run timeout"
```

---

## Task 6: End-to-end wiring test + docs

**Files:**
- Test: `backend/tests/runs.e2e.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: nothing new for other tasks — this is the plan's final proof that submit → webhook → poll works together through the real routes.

- [ ] **Step 1: Write the end-to-end test**

Create `backend/tests/runs.e2e.test.ts`:

```ts
import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

jest.mock('passport', () => {
  const actual = jest.requireActual('passport')
  const originalAuthenticate = actual.authenticate.bind(actual)
  return Object.assign(actual, {
    authenticate: (strategy: string, ...args: any[]) => {
      if (strategy === 'session') {
        return originalAuthenticate(strategy, ...args)
      }
      return (req: any, _res: any, next: any) => {
        req.user = { id: TEST_USER_ID, username: 'octocat', avatarUrl: null, isAdmin: false }
        req.login(req.user, (err: Error) => next(err))
      }
    },
  })
})

const TEST_USER_ID = 'e2e-test-user'
const CHALLENGE_ID = 'e2e-test-challenge'
const prisma = new PrismaClient()

describe('run submission end-to-end', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, githubId: 'gh-e2e-test', username: 'octocat' },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_ID },
      update: {},
      create: { id: CHALLENGE_ID, title: 'E2E Todo CRUD', category: 'crud', points: 25, yamlPath: 'todo-api-crud.yaml' },
    })
  })

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId: TEST_USER_ID } })
    await prisma.challenge.delete({ where: { id: CHALLENGE_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('submit -> webhook callback -> poll reflects the final score', async () => {
    let app: ReturnType<typeof createApp>

    // Stands in for the Java validation engine: instead of really calling out to it, fires
    // the same callback a real run would make, against this same app instance — proving the
    // webhookUrl/token this app constructs is one this app's own webhook route accepts.
    const fetchImpl = jest.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      const webhookUrl = new URL(body.webhookUrl)
      await request(app)
        .post(webhookUrl.pathname + webhookUrl.search)
        .send({
          status: 'completed',
          score: 100,
          checks: [
            { name: 'POST /todos creates a todo', status: 'passed', points: 10, pointsEarned: 10, assertions: [] },
          ],
        })
      return { ok: true, status: 202 } as Response
    }) as any

    app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const submitRes = await agent.post('/api/runs').send({
      challengeId: CHALLENGE_ID,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })
    expect(submitRes.status).toBe(202)

    const pollRes = await agent.get(`/api/runs/${submitRes.body.runId}`)
    expect(pollRes.status).toBe(200)
    expect(pollRes.body.status).toBe('completed')
    expect(pollRes.body.score).toBe(100)
    expect(pollRes.body.checks).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test -- runs.e2e.test.ts`
Expected: PASS (1 test) — if it fails, re-check that Tasks 1–5 are all committed and `npm run seed:challenges` was not required (this test seeds its own `Challenge` row directly via Prisma, independent of the seed script).

- [ ] **Step 3: Run the full backend suite**

Run: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test`
Expected: PASS (all suites — health, auth, me, challenges, runs, webhook, e2e)

- [ ] **Step 4: Document the new pieces in the README**

Modify `README.md` — add a new item to the end of the numbered "Local setup" list (currently ends at step 7 `cd frontend && npm install && npm run dev`):

```markdown
8. Seed the challenge catalog and (optionally) run the validation engine locally — see
   "Challenges & the validation engine" below.
```

Then add a new section after "## Admin access":

```markdown
## Challenges & the validation engine

The backend orchestrates challenge runs by calling the Java `validation-engine` service and
receiving results via a webhook it exposes itself — see
`docs/superpowers/specs/2026-08-06-node-orchestrator-design.md` for the full design.

1. Seed the challenge catalog (run once after `prisma migrate dev`, and again whenever a YAML
   file under `backend/challenges/` changes): `cd backend && npm run seed:challenges`
2. Run the validation engine alongside the backend: `cd validation-engine && mvn spring-boot:run`
   (listens on port 8080 by default, matching `VALIDATION_ENGINE_URL`'s default in
   `backend/.env.example`).
3. `WEBHOOK_BASE_URL` must be a host the validation engine can actually reach. The
   `http://localhost:4000` default works when both run on the same machine; in any other
   deployment (e.g. the validation engine on a separate host or container) it needs to be the
   backend's real reachable address.
```

- [ ] **Step 5: Commit**

```bash
git add backend/tests/runs.e2e.test.ts README.md
git commit -m "test: prove run submission end-to-end through the real routes, document the flow"
```
