import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

// `mockAuthUser` (not `global`) because Jest's module-factory hoisting only allows
// referencing out-of-scope variables whose name starts with "mock" — this is the
// standard Jest pattern for a mock whose behavior needs to vary between tests in the
// same file (here: which user is "authenticated," to exercise both the admin and
// non-admin path against the same route without two separate test files).
let mockAuthUser = { id: 'admin-routes-test-admin', isAdmin: true }

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
const ADMIN_USER_ID = 'admin-routes-test-admin'
const NON_ADMIN_USER_ID = 'admin-routes-test-non-admin'

describe('GET/PUT /api/admin/llm-settings', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: ADMIN_USER_ID },
      update: { isAdmin: true },
      create: { id: ADMIN_USER_ID, githubId: 'gh-admin-routes-test-admin', username: 'admin-octocat', isAdmin: true },
    })
    await prisma.user.upsert({
      where: { id: NON_ADMIN_USER_ID },
      update: { isAdmin: false },
      create: { id: NON_ADMIN_USER_ID, githubId: 'gh-admin-routes-test-plain', username: 'plain-octocat', isAdmin: false },
    })
  })

  afterEach(async () => {
    await prisma.llmSettings.deleteMany({})
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: ADMIN_USER_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: NON_ADMIN_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  beforeEach(() => {
    mockAuthUser = { id: ADMIN_USER_ID, isAdmin: true }
  })

  it('GET returns 401 when not authenticated', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/admin/llm-settings')
    expect(res.status).toBe(401)
  })

  it('GET returns 403 for an authenticated non-admin', async () => {
    mockAuthUser = { id: NON_ADMIN_USER_ID, isAdmin: false }
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/admin/llm-settings')
    expect(res.status).toBe(403)
  })

  it('GET returns defaults before any save, and PUT saves and is reflected on the next GET', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const before = await agent.get('/api/admin/llm-settings')
    expect(before.status).toBe(200)
    expect(before.body).toEqual({ provider: null, model: null, baseUrl: null, apiKeySet: false })

    const put = await agent
      .put('/api/admin/llm-settings')
      .send({ provider: 'claude', model: 'claude-sonnet-5', apiKey: 'sk-test-key' })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ provider: 'claude', model: 'claude-sonnet-5', baseUrl: null, apiKeySet: true })

    const after = await agent.get('/api/admin/llm-settings')
    expect(after.status).toBe(200)
    expect(after.body).toEqual({ provider: 'claude', model: 'claude-sonnet-5', baseUrl: null, apiKeySet: true })
  })

  it('PUT returns 400 on a validation error and does not save', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.put('/api/admin/llm-settings').send({ provider: 'bogus', model: 'x' })
    expect(res.status).toBe(400)
  })

  it('PUT returns 403 for an authenticated non-admin', async () => {
    mockAuthUser = { id: NON_ADMIN_USER_ID, isAdmin: false }
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent
      .put('/api/admin/llm-settings')
      .send({ provider: 'claude', model: 'claude-sonnet-5', apiKey: 'sk-test' })
    expect(res.status).toBe(403)
  })

  it('PUT returns 500 instead of hanging or crashing the process when ENCRYPTION_KEY is malformed', async () => {
    // Build the app (and log in) while ENCRYPTION_KEY is still valid, since app.ts now
    // fails fast at construction time on a malformed key (see app.ts). Swapping in the
    // invalid value only after the app exists isolates this test to the PUT handler's
    // own try/catch (admin/routes.ts), which is what this test is actually verifying.
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const originalEncryptionKey = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = 'not-32-bytes'

    try {
      const res = await agent
        .put('/api/admin/llm-settings')
        .send({ provider: 'claude', model: 'claude-sonnet-5', apiKey: 'sk-test-key' })
      expect(res.status).toBe(500)
      expect(res.body).toEqual({ error: 'failed to save settings' })
    } finally {
      process.env.ENCRYPTION_KEY = originalEncryptionKey
    }
  })
})
