import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

jest.mock('passport', () => {
  const actual = jest.requireActual('passport')
  // NOTE: `actual` is passport's exported singleton (`new Authenticator()`); its
  // `use`/`initialize`/`session`/`serializeUser`/`deserializeUser` methods live on
  // `Authenticator.prototype`, not as own properties. A `{ ...actual, authenticate: ... }`
  // spread (as in the original brief snippet) only copies own enumerable properties and
  // silently drops all prototype methods, causing `passport.use is not a function` at
  // `configurePassport()` time. Mutating and returning the same singleton instead keeps
  // every real method intact and only shadows `authenticate` with an own property.
  const originalAuthenticate = actual.authenticate.bind(actual)

  return Object.assign(actual, {
    authenticate: (strategy: string, options: any = {}) => {
      // `passport.session()` is just `authenticate('session')`. Mocking it too meant every
      // non-callback request — including GET /api/me and GET /auth/logout — was answered by
      // this mock's redirect and never reached its route, so the logout assertion below was
      // really asserting on the session middleware. Delegate 'session' to the real
      // implementation so session state (and its destruction) is genuinely exercised.
      if (strategy === 'session') {
        return originalAuthenticate(strategy, options)
      }

      return (req: any, res: any, next: any) => {
        const isCallback = req.path.includes('callback')

        if (isCallback && req.query.fail === 'true') {
          return res.redirect(options.failureRedirect ?? '/')
        }

        if (!isCallback) {
          // Mirrors real passport-oauth2 "initiate" behavior: redirect the user-agent to the
          // provider's authorization endpoint and end the response there — it never calls
          // next(). Without this branch, the mock would call next() for GET /auth/github too,
          // but that route has no handler after passport.authenticate, so the request would
          // fall through to Express's 404 handler instead of redirecting anywhere.
          return res.redirect('https://github.com/login/oauth/authorize')
        }

        req.user = { id: TEST_USER_ID, username: 'octocat', isAdmin: false }
        req.login(req.user, (err: Error) => {
          if (err) return next(err)
          next()
        })
      }
    },
  })
})

// Must match the row seeded below: the real 'session' strategy runs deserializeUser, which
// looks this id up via Prisma on every authenticated request.
const TEST_USER_ID = 'auth-routes-test-user'

const prisma = new PrismaClient()

// Rows in the connect-pg-simple `session` table belonging to our test user. Counting these
// is what pins `req.session.destroy()` specifically — `res.clearCookie()` alone would end
// the *client's* session (and so still yield a 401 below) while orphaning the server row.
async function storedSessionCount(): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) FROM "session" WHERE "sess"->'passport'->>'user' = ${TEST_USER_ID}
  `
  return Number(rows[0].count)
}

describe('GitHub OAuth routes', () => {
  // Every login in this file writes a row for the same user, so clear them between tests
  // (and ahead of the first one, in case an earlier run aborted) to keep the counts exact.
  beforeEach(async () => {
    await prisma.$executeRaw`
      DELETE FROM "session" WHERE "sess"->'passport'->>'user' = ${TEST_USER_ID}
    `
  })

  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: {
        id: TEST_USER_ID,
        githubId: 'gh-auth-routes-test',
        username: 'octocat',
        avatarUrl: null,
        isAdmin: false,
      },
    })
  })

  afterAll(async () => {
    await prisma.$executeRaw`
      DELETE FROM "session" WHERE "sess"->'passport'->>'user' = ${TEST_USER_ID}
    `
    await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

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

  it('redirects a failed callback to the frontend, not to the backend root', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/auth/github/callback?fail=true')

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(process.env.FRONTEND_URL)
  })

  it('destroys the session on /auth/logout', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)

    await agent.get('/auth/github/callback')

    // Prove the session was actually established first, otherwise the 401 after logout
    // would be indistinguishable from "login never worked".
    const before = await agent.get('/api/me')
    expect(before.status).toBe(200)
    expect(await storedSessionCount()).toBe(1)

    const logoutRes = await agent.get('/auth/logout')
    expect(logoutRes.status).toBe(302)

    // The same cookie jar no longer authenticates. A bare 302 would still pass with
    // req.logout()/session.destroy()/clearCookie() all deleted.
    const after = await agent.get('/api/me')
    expect(after.status).toBe(401)

    // ...and the server-side session row is gone, not merely orphaned.
    expect(await storedSessionCount()).toBe(0)
  })
})
