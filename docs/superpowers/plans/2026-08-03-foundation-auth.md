# Foundation (Auth + Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo skeleton (Node/Express backend + Next.js frontend + Postgres), with a working GitHub OAuth login/logout flow and a protected `/api/me` endpoint the frontend can call to render a logged-in dashboard.

**Architecture:** Two independently deployable services in one repo: `backend/` (Express + TypeScript + Prisma/Postgres) owns the database, sessions, and auth; `frontend/` (Next.js + TypeScript) is a thin client that redirects to the backend for GitHub OAuth and calls backend JSON endpoints with credentials. Sessions are cookie-based (`express-session`), stored in Postgres via `connect-pg-simple` — no Redis in the foundation. The Java validation engine and YAML rule engine are out of scope for this plan (separate plan #2); nothing here blocks on them.

**Tech Stack:** Node.js 20 + TypeScript, Express, Prisma (Postgres), Passport.js (`passport-github2`), `express-session` + `connect-pg-simple`, Jest + Supertest (backend tests). Next.js 14 (App Router) + TypeScript, Vitest + React Testing Library (frontend tests).

## Global Constraints

- Login only via GitHub OAuth — no email/password flow (from `PLANO_MVP.md`, section "Autenticação").
- Admin access is a fixed allowlist of GitHub usernames (`is_admin` flag) — no RBAC/roles system (section "Painel Admin").
- Node.js is the sole owner of the database; no other service gets direct DB credentials in this plan (section "Arquitetura técnica").
- Target hosting is a managed PaaS (Railway/Render/Fly.io); nothing in this plan should assume a specific host beyond standard `DATABASE_URL`/env-var configuration.

---

## Task 1: Monorepo scaffold + backend health check

**Files:**
- Create: `package.json` (root, npm workspaces)
- Create: `.gitignore`
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `backend/src/app.ts`
- Create: `backend/src/server.ts`
- Test: `backend/tests/health.test.ts`

**Interfaces:**
- Produces: `createApp(): express.Express` from `backend/src/app.ts` — used by every later backend task to mount routes and by tests via `supertest(createApp())`.

- [ ] **Step 1: Initialize the repo and root workspace**

```bash
cd /Users/rickoliveira/Documents/personal/LetCodeClaude
git init
```

Create `.gitignore`:

```
node_modules/
dist/
.env
.env.test
.next/
*.log
```

Create root `package.json`:

```json
{
  "name": "practice-platform",
  "private": true,
  "workspaces": ["backend", "frontend"]
}
```

- [ ] **Step 2: Scaffold the backend package**

Create `backend/package.json`:

```json
{
  "name": "backend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "ts-node-dev --respawn src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "jest --runInBand"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.19.2"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.0",
    "@types/supertest": "^6.0.2",
    "jest": "^29.7.0",
    "supertest": "^6.3.4",
    "ts-jest": "^29.1.4",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.4.5"
  }
}
```

Create `backend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

Create `backend/jest.config.js`:

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
}
```

Run: `cd backend && npm install`

- [ ] **Step 3: Write the failing test for the health endpoint**

Create `backend/tests/health.test.ts`:

```ts
import request from 'supertest'
import { createApp } from '../src/app'

describe('GET /health', () => {
  it('returns status ok', async () => {
    const app = createApp()
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd backend && npm test -- health.test.ts`
Expected: FAIL — `Cannot find module '../src/app'`

- [ ] **Step 5: Implement the minimal app**

Create `backend/src/app.ts`:

```ts
import express from 'express'
import cors from 'cors'

export function createApp() {
  const app = express()

  app.use(
    cors({
      origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
      credentials: true,
    })
  )
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  return app
}
```

Create `backend/src/server.ts`:

```ts
import { createApp } from './app'

const port = process.env.PORT ?? 4000
const app = createApp()

app.listen(port, () => {
  console.log(`backend listening on port ${port}`)
})
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && npm test -- health.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add package.json .gitignore backend/
git commit -m "chore: scaffold backend with health check endpoint"
```

---

## Task 2: Postgres + Prisma User model with admin allowlist

**Files:**
- Create: `backend/prisma/schema.prisma`
- Create: `backend/src/db/client.ts`
- Create: `backend/src/users/service.ts`
- Create: `backend/.env.example`
- Test: `backend/tests/users.service.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly (independent of `createApp`).
- Produces: `prisma` singleton from `backend/src/db/client.ts`; `findOrCreateUserByGithubProfile(prisma, profile): Promise<User>` and `isAllowlistedAdmin(username: string): boolean` from `backend/src/users/service.ts` — used by Task 3's Passport strategy and Task 4's `/api/me` route.

- [ ] **Step 1: Add Prisma and Postgres driver**

Run: `cd backend && npm install @prisma/client && npm install -D prisma`

Create `backend/.env.example`:

```
DATABASE_URL="postgresql://localhost:5432/practice_platform"
FRONTEND_URL="http://localhost:3000"
SESSION_SECRET="replace-me"
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""
GITHUB_CALLBACK_URL="http://localhost:4000/auth/github/callback"
ADMIN_GITHUB_USERNAMES=""
PORT=4000
```

Copy it locally and create the databases:

```bash
cp .env.example .env
createdb practice_platform
createdb practice_platform_test
```

- [ ] **Step 2: Define the User model**

Create `backend/prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id @default(uuid())
  githubId  String   @unique
  username  String
  avatarUrl String?
  isAdmin   Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

Run: `cd backend && npx prisma migrate dev --name init`
(This applies the migration to `practice_platform`. Point `DATABASE_URL` at `practice_platform_test` and re-run the same command against the test database, or run `npx prisma migrate deploy` against it.)

- [ ] **Step 3: Add the Prisma client singleton**

Create `backend/src/db/client.ts`:

```ts
import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()
```

- [ ] **Step 4: Write the failing test for the user service**

Create `backend/tests/users.service.test.ts`:

```ts
import { PrismaClient } from '@prisma/client'
import { findOrCreateUserByGithubProfile, isAllowlistedAdmin } from '../src/users/service'

const prisma = new PrismaClient()

describe('users/service', () => {
  beforeEach(async () => {
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates a new user from a github profile', async () => {
    const user = await findOrCreateUserByGithubProfile(prisma, {
      id: 'gh-1',
      username: 'octocat',
      photos: [{ value: 'https://example.com/avatar.png' }],
    })

    expect(user.githubId).toBe('gh-1')
    expect(user.username).toBe('octocat')
    expect(user.avatarUrl).toBe('https://example.com/avatar.png')
    expect(user.isAdmin).toBe(false)
  })

  it('updates username on repeat login instead of duplicating', async () => {
    await findOrCreateUserByGithubProfile(prisma, { id: 'gh-1', username: 'octocat' })
    const updated = await findOrCreateUserByGithubProfile(prisma, {
      id: 'gh-1',
      username: 'octocat-renamed',
    })

    const count = await prisma.user.count()
    expect(count).toBe(1)
    expect(updated.username).toBe('octocat-renamed')
  })

  it('marks a user admin when their github username is allowlisted', async () => {
    process.env.ADMIN_GITHUB_USERNAMES = 'foundera,founderb'

    const user = await findOrCreateUserByGithubProfile(prisma, {
      id: 'gh-2',
      username: 'FounderA',
    })

    expect(user.isAdmin).toBe(true)
  })
})

describe('isAllowlistedAdmin', () => {
  it('matches case-insensitively', () => {
    process.env.ADMIN_GITHUB_USERNAMES = 'foundera,founderb'
    expect(isAllowlistedAdmin('FounderA')).toBe(true)
    expect(isAllowlistedAdmin('someone-else')).toBe(false)
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd backend && DATABASE_URL="postgresql://localhost:5432/practice_platform_test" npm test -- users.service.test.ts`
Expected: FAIL — `Cannot find module '../src/users/service'`

- [ ] **Step 6: Implement the user service**

Create `backend/src/users/service.ts`:

```ts
import { PrismaClient, User } from '@prisma/client'

export function isAllowlistedAdmin(username: string): boolean {
  const admins = (process.env.ADMIN_GITHUB_USERNAMES ?? '')
    .split(',')
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean)

  return admins.includes(username.toLowerCase())
}

export type GithubProfileInput = {
  id: string
  username: string
  photos?: { value: string }[]
}

export async function findOrCreateUserByGithubProfile(
  prisma: PrismaClient,
  profile: GithubProfileInput
): Promise<User> {
  const isAdmin = isAllowlistedAdmin(profile.username)
  const avatarUrl = profile.photos?.[0]?.value

  return prisma.user.upsert({
    where: { githubId: profile.id },
    update: { username: profile.username, avatarUrl, isAdmin },
    create: {
      githubId: profile.id,
      username: profile.username,
      avatarUrl,
      isAdmin,
    },
  })
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://localhost:5432/practice_platform_test" npm test -- users.service.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 8: Commit**

```bash
git add backend/prisma backend/src/db backend/src/users backend/.env.example backend/tests/users.service.test.ts
git commit -m "feat: add User model and github-profile upsert with admin allowlist"
```

---

## Task 3: Session store + GitHub OAuth (Passport)

**Files:**
- Create: `backend/src/auth/passport.ts`
- Create: `backend/src/auth/routes.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/tests/auth.routes.test.ts`

**Interfaces:**
- Consumes: `findOrCreateUserByGithubProfile`, `isAllowlistedAdmin` from `backend/src/users/service.ts` (Task 2); `prisma` from `backend/src/db/client.ts` (Task 2).
- Produces: `configurePassport(prisma: PrismaClient): void` from `backend/src/auth/passport.ts`; `authRouter: express.Router` from `backend/src/auth/routes.ts`, mounted at root and exposing `GET /auth/github`, `GET /auth/github/callback`, `GET /auth/logout` — used by Task 4 (relies on `req.user` being populated) and by the frontend (Task 5).
- Produces (updated): `createApp(deps?: { prisma?: PrismaClient }): express.Express` — now accepts an injectable `prisma` for tests; used by Task 4's tests.

- [ ] **Step 1: Install session/auth dependencies**

Run: `cd backend && npm install express-session connect-pg-simple passport passport-github2 pg`
Run: `cd backend && npm install -D @types/express-session @types/passport @types/passport-github2 @types/pg`

- [ ] **Step 2: Write the failing test for the OAuth routes**

Create `backend/tests/auth.routes.test.ts`:

```ts
import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

jest.mock('passport', () => {
  const actual = jest.requireActual('passport')
  return {
    ...actual,
    authenticate: (_strategy: string, options: any = {}) => (req: any, res: any, next: any) => {
      if (req.path.includes('callback') && req.query.fail === 'true') {
        return res.redirect(options.failureRedirect ?? '/')
      }
      req.user = { id: 'test-user-id', username: 'octocat', isAdmin: false }
      req.login(req.user, (err: Error) => {
        if (err) return next(err)
        next()
      })
    },
  }
})

const prisma = new PrismaClient()

describe('GitHub OAuth routes', () => {
  it('redirects to github on GET /auth/github', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/auth/github')
    expect([302, 200]).toContain(res.status)
  })

  it('establishes a session and redirects to the frontend dashboard on callback success', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/auth/github/callback')

    expect(res.status).toBe(302)
    expect(res.headers.location).toContain('/dashboard')
    expect(res.headers['set-cookie']).toBeDefined()
  })

  it('destroys the session on /auth/logout', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)

    await agent.get('/auth/github/callback')
    const logoutRes = await agent.get('/auth/logout')

    expect(logoutRes.status).toBe(302)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && npm test -- auth.routes.test.ts`
Expected: FAIL — `createApp` does not accept a `deps` argument / `/auth/github` returns 404

- [ ] **Step 4: Implement Passport configuration**

Create `backend/src/auth/passport.ts`:

```ts
import passport from 'passport'
import { Strategy as GitHubStrategy } from 'passport-github2'
import { PrismaClient } from '@prisma/client'
import { findOrCreateUserByGithubProfile } from '../users/service'

export function configurePassport(prisma: PrismaClient) {
  passport.use(
    new GitHubStrategy(
      {
        clientID: process.env.GITHUB_CLIENT_ID ?? '',
        clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
        callbackURL: process.env.GITHUB_CALLBACK_URL ?? '',
      },
      async (_accessToken: string, _refreshToken: string, profile: any, done: any) => {
        try {
          const user = await findOrCreateUserByGithubProfile(prisma, {
            id: profile.id,
            username: profile.username,
            photos: profile.photos,
          })
          done(null, user)
        } catch (err) {
          done(err as Error)
        }
      }
    )
  )

  passport.serializeUser((user: any, done) => done(null, user.id))
  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await prisma.user.findUnique({ where: { id } })
      done(null, user)
    } catch (err) {
      done(err)
    }
  })
}
```

- [ ] **Step 5: Implement the auth routes**

Create `backend/src/auth/routes.ts`:

```ts
import { Router } from 'express'
import passport from 'passport'

export const authRouter = Router()

authRouter.get('/auth/github', passport.authenticate('github', { scope: ['user:email'] }))

authRouter.get(
  '/auth/github/callback',
  passport.authenticate('github', { failureRedirect: '/' }),
  (_req, res) => {
    res.redirect(`${process.env.FRONTEND_URL}/dashboard`)
  }
)

authRouter.get('/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err)
    req.session.destroy(() => {
      res.clearCookie('connect.sid')
      res.redirect(process.env.FRONTEND_URL ?? '/')
    })
  })
})
```

- [ ] **Step 6: Wire sessions + passport + auth routes into the app**

Modify `backend/src/app.ts`:

```ts
import express from 'express'
import cors from 'cors'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from './db/client'
import { configurePassport } from './auth/passport'
import { authRouter } from './auth/routes'

export function createApp(deps: { prisma?: PrismaClient } = {}) {
  const prisma = deps.prisma ?? defaultPrisma
  const app = express()

  app.use(
    cors({
      origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
      credentials: true,
    })
  )
  app.use(express.json())

  const PgSession = connectPgSimple(session)
  const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL })

  app.use(
    session({
      store: new PgSession({ pool: sessionPool, createTableIfMissing: true }),
      secret: process.env.SESSION_SECRET ?? 'dev-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' },
    })
  )

  configurePassport(prisma)
  app.use(passport.initialize())
  app.use(passport.session())

  app.use(authRouter)

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  return app
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://localhost:5432/practice_platform_test" npm test -- auth.routes.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 8: Run the full backend test suite to check nothing broke**

Run: `cd backend && DATABASE_URL="postgresql://localhost:5432/practice_platform_test" npm test`
Expected: PASS (all suites)

- [ ] **Step 9: Commit**

```bash
git add backend/src/auth backend/src/app.ts backend/tests/auth.routes.test.ts backend/package.json
git commit -m "feat: add github oauth login, session store and logout route"
```

---

## Task 4: `requireAuth` middleware + protected `/api/me`

**Files:**
- Create: `backend/src/auth/middleware.ts`
- Create: `backend/src/users/routes.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/tests/me.routes.test.ts`

**Interfaces:**
- Consumes: session/passport wiring from Task 3 (`req.isAuthenticated()`, `req.user`).
- Produces: `requireAuth: express.RequestHandler` from `backend/src/auth/middleware.ts` — reusable by any future protected route (e.g. admin routes in plan #5); `meRouter: express.Router` exposing `GET /api/me`.

- [ ] **Step 1: Write the failing test for `/api/me`**

Create `backend/tests/me.routes.test.ts`:

```ts
import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

jest.mock('passport', () => {
  const actual = jest.requireActual('passport')
  return {
    ...actual,
    authenticate: (_strategy: string) => (req: any, _res: any, next: any) => {
      req.user = { id: 'test-user-id', username: 'octocat', avatarUrl: null, isAdmin: true }
      req.login(req.user, (err: Error) => next(err))
    },
  }
})

const prisma = new PrismaClient()

describe('GET /api/me', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/me')
    expect(res.status).toBe(401)
  })

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
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npm test -- me.routes.test.ts`
Expected: FAIL — `GET /api/me` returns 404

- [ ] **Step 3: Implement `requireAuth`**

Create `backend/src/auth/middleware.ts`:

```ts
import { Request, Response, NextFunction } from 'express'

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: 'not_authenticated' })
    return
  }
  next()
}
```

- [ ] **Step 4: Implement `/api/me`**

Create `backend/src/users/routes.ts`:

```ts
import { Router } from 'express'
import { requireAuth } from '../auth/middleware'

export const meRouter = Router()

meRouter.get('/api/me', requireAuth, (req, res) => {
  const user = req.user as {
    id: string
    username: string
    avatarUrl: string | null
    isAdmin: boolean
  }

  res.json({
    id: user.id,
    username: user.username,
    avatarUrl: user.avatarUrl,
    isAdmin: user.isAdmin,
  })
})
```

- [ ] **Step 5: Mount the router**

Modify `backend/src/app.ts` — add the import and mount call next to `authRouter`:

```ts
import { meRouter } from './users/routes'
```

```ts
app.use(authRouter)
app.use(meRouter)
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && DATABASE_URL="postgresql://localhost:5432/practice_platform_test" npm test -- me.routes.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && DATABASE_URL="postgresql://localhost:5432/practice_platform_test" npm test`
Expected: PASS (all suites)

- [ ] **Step 8: Commit**

```bash
git add backend/src/auth/middleware.ts backend/src/users/routes.ts backend/src/app.ts backend/tests/me.routes.test.ts
git commit -m "feat: add requireAuth middleware and protected /api/me endpoint"
```

---

## Task 5: Next.js frontend — login page + protected dashboard

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/next.config.js`
- Create: `frontend/app/layout.tsx`
- Create: `frontend/app/page.tsx`
- Create: `frontend/app/dashboard/page.tsx`
- Create: `frontend/.env.local.example`
- Create: `frontend/vitest.config.ts`
- Test: `frontend/tests/page.test.tsx`
- Test: `frontend/tests/dashboard.test.tsx`

**Interfaces:**
- Consumes: `GET /auth/github` (redirect target for the login link) and `GET /api/me` (returns `{ id, username, avatarUrl, isAdmin }` or 401) from the backend (Tasks 3 and 4).
- Produces: nothing consumed by later tasks in this plan (frontend leaf of the Foundation slice).

- [ ] **Step 1: Scaffold the Next.js app**

Create `frontend/package.json`:

```json
{
  "name": "frontend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "^14.2.3",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.6",
    "@testing-library/react": "^15.0.7",
    "@types/react": "^18.3.3",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^24.1.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

Create `frontend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "lib": ["dom", "dom.iterable", "esnext"],
    "jsx": "preserve",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "incremental": true
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"]
}
```

Create `frontend/next.config.js`:

```js
/** @type {import('next').NextConfig} */
module.exports = {}
```

Create `frontend/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
```

Create `frontend/.env.local.example`:

```
NEXT_PUBLIC_BACKEND_URL=http://localhost:4000
```

Create `frontend/app/layout.tsx`:

```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
```

Run: `cd frontend && npm install`

- [ ] **Step 2: Write the failing test for the login page**

Create `frontend/tests/page.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import HomePage from '../app/page'

describe('HomePage', () => {
  it('renders a link to start the github oauth flow', () => {
    render(<HomePage />)
    const link = screen.getByRole('link', { name: /login with github/i })
    expect(link).toHaveAttribute('href', 'http://localhost:4000/auth/github')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test -- page.test.tsx`
Expected: FAIL — `Cannot find module '../app/page'`

- [ ] **Step 4: Implement the login page**

Create `frontend/app/page.tsx`:

```tsx
export default function HomePage() {
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL

  return (
    <main>
      <h1>Practice Platform</h1>
      <a href={`${backendUrl}/auth/github`}>Login with GitHub</a>
    </main>
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test -- page.test.tsx`
Expected: PASS

- [ ] **Step 6: Write the failing tests for the dashboard page**

Create `frontend/tests/dashboard.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import DashboardPage from '../app/dashboard/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
}))

describe('DashboardPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
  })

  it('shows the username when the session is valid', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ id: '1', username: 'octocat', avatarUrl: null, isAdmin: false }),
    }) as any

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/welcome, octocat/i)).toBeInTheDocument()
    })
  })

  it('redirects to the login page when the session is missing', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 401 }) as any

    render(<DashboardPage />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/')
    })
  })
})
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `cd frontend && npm test -- dashboard.test.tsx`
Expected: FAIL — `Cannot find module '../app/dashboard/page'`

- [ ] **Step 8: Implement the dashboard page**

Create `frontend/app/dashboard/page.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
}

export default function DashboardPage() {
  const router = useRouter()
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL

    fetch(`${backendUrl}/api/me`, { credentials: 'include' })
      .then((res) => {
        if (res.status === 401) {
          router.replace('/')
          return null
        }
        return res.json()
      })
      .then((data) => {
        if (data) setMe(data)
        setLoading(false)
      })
  }, [router])

  if (loading) return <p>Loading...</p>
  if (!me) return null

  return (
    <main>
      <h1>Welcome, {me.username}</h1>
      {me.isAdmin && <p>Admin access enabled</p>}
      <a href={`${process.env.NEXT_PUBLIC_BACKEND_URL}/auth/logout`}>Logout</a>
    </main>
  )
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test -- dashboard.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 10: Run the full frontend suite**

Run: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test`
Expected: PASS (all suites)

- [ ] **Step 11: Commit**

```bash
git add frontend/
git commit -m "feat: add login page and protected dashboard consuming /api/me"
```

---

## Task 6: End-to-end wiring, env docs, and manual OAuth verification

**Files:**
- Create: `README.md`
- Modify: `backend/.env.example`
- Modify: `frontend/.env.local.example`

**Interfaces:**
- Consumes: nothing new — this task wires and documents what Tasks 1-5 already produced.
- Produces: nothing consumed elsewhere; this is the final task of the Foundation plan.

The automated tests in Tasks 1-5 mock GitHub's OAuth handshake because it can't be exercised without a live GitHub OAuth App and network access. This task documents the one-time manual check that the real flow works end-to-end.

- [ ] **Step 1: Register a GitHub OAuth App for local development**

Manual (no code): go to GitHub Settings → Developer settings → OAuth Apps → New OAuth App.
- Homepage URL: `http://localhost:3000`
- Authorization callback URL: `http://localhost:4000/auth/github/callback`

Copy the generated Client ID/Secret into `backend/.env` (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`).

- [ ] **Step 2: Document required env vars in the README**

Create `README.md`:

```markdown
# Practice Platform

## Local setup

1. `createdb practice_platform && createdb practice_platform_test`
2. `cp backend/.env.example backend/.env` and fill in `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`.
3. `cp frontend/.env.local.example frontend/.env.local`
4. `cd backend && npm install && npx prisma migrate dev`
5. `cd backend && npm run dev` (port 4000)
6. `cd frontend && npm install && npm run dev` (port 3000)

## Running tests

- Backend: `cd backend && DATABASE_URL="postgresql://localhost:5432/practice_platform_test" npm test`
- Frontend: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test`

## Admin access

Add a comma-separated list of GitHub usernames to `ADMIN_GITHUB_USERNAMES` in `backend/.env` to grant admin flag on login.
```

- [ ] **Step 3: Run the real OAuth flow manually**

Manual (no code):
1. Start backend (`npm run dev` in `backend/`) and frontend (`npm run dev` in `frontend/`).
2. Open `http://localhost:3000`, click "Login with GitHub".
3. Approve the GitHub authorization prompt.
4. Confirm you land on `http://localhost:3000/dashboard` showing "Welcome, `<your-github-username>`".
5. Click "Logout", confirm you're redirected back and that reloading `/dashboard` redirects to `/` (session cleared).
6. Add your own GitHub username to `ADMIN_GITHUB_USERNAMES` in `backend/.env`, restart the backend, log in again, confirm "Admin access enabled" appears on the dashboard.

- [ ] **Step 4: Commit the documentation**

```bash
git add README.md
git commit -m "docs: document local setup and manual github oauth verification"
```

---

## Self-Review Notes

- **Spec coverage:** monorepo scaffold ✓ (Task 1), Postgres/User model + admin allowlist ✓ (Task 2), GitHub OAuth login/logout ✓ (Task 3), protected `/api/me` ✓ (Task 4), Next.js login + dashboard ✓ (Task 5), env docs + manual verification of the one thing that can't be unit-tested (real GitHub handshake) ✓ (Task 6). Java validation engine, YAML rule engine, billing, admin UI, and ToS are explicitly out of scope for this plan — covered by plans #2 through #6 in `PLANO_MVP.md`'s execution breakdown.
- **Placeholder scan:** no TBD/"add error handling"/"similar to Task N" phrases; every step has runnable code or an explicit manual instruction.
- **Type consistency:** `Me`/user shape `{ id, username, avatarUrl, isAdmin }` matches across `backend/src/users/routes.ts` (Task 4) and `frontend/app/dashboard/page.tsx` (Task 5). `findOrCreateUserByGithubProfile` and `isAllowlistedAdmin` names match between definition (Task 2) and consumption (Task 3).
