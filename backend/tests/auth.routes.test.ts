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
  return Object.assign(actual, {
    authenticate: (_strategy: string, options: any = {}) => (req: any, res: any, next: any) => {
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

      req.user = { id: 'test-user-id', username: 'octocat', isAdmin: false }
      req.login(req.user, (err: Error) => {
        if (err) return next(err)
        next()
      })
    },
  })
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
