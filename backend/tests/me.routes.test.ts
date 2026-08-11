import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

jest.mock('passport', () => {
  const actual = jest.requireActual('passport')
  const originalAuthenticate = actual.authenticate.bind(actual)
  return Object.assign(actual, {
    authenticate: (strategy: string, ...args: any[]) => {
      // Delegate to real authenticate for session strategy so that real deserializeUser
      // and DB lookups are exercised; only mock the github strategy for OAuth testing
      if (strategy === 'session') {
        return originalAuthenticate(strategy, ...args)
      }

      // Mock github strategy
      return (req: any, _res: any, next: any) => {
        const isCallback = req.path.includes('callback')
        if (isCallback) {
          req.user = { id: 'test-user-id', username: 'octocat', avatarUrl: null, isAdmin: true }
          req.login(req.user, (err: Error) => next(err))
        } else {
          _res.redirect('https://github.com/login/oauth/authorize')
        }
      }
    },
  })
})

const prisma = new PrismaClient()

describe('GET /api/me', () => {
  beforeAll(async () => {
    // Create test user for authenticated test
    await prisma.user.upsert({
      where: { id: 'test-user-id' },
      update: {},
      create: {
        id: 'test-user-id',
        githubId: '1',
        username: 'octocat',
        avatarUrl: null,
        isAdmin: true,
      },
    })
  })

  afterAll(async () => {
    // Clean up test user
    await prisma.user.delete({ where: { id: 'test-user-id' } }).catch(() => {})
    await prisma.$disconnect()
  })

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
      tosAcceptanceRequired: false,
      hideFromRanking: false,
      isPaid: false,
    })
  })

  it('returns tosAcceptanceRequired: true once a version is published and not yet accepted', async () => {
    const version = await prisma.tosVersion.create({ data: { content: 'v1' } })
    try {
      const app = createApp({ prisma })
      const agent = request.agent(app)
      await agent.get('/auth/github/callback')

      const res = await agent.get('/api/me')
      expect(res.body.tosAcceptanceRequired).toBe(true)

      await prisma.tosAcceptance.create({ data: { userId: 'test-user-id', tosVersionId: version.id } })
      const after = await agent.get('/api/me')
      expect(after.body.tosAcceptanceRequired).toBe(false)
    } finally {
      await prisma.tosAcceptance.deleteMany({})
      await prisma.tosVersion.deleteMany({})
    }
  })

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

  it('GET /api/me includes isPaid', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/me')
    expect(res.body.isPaid).toBe(false)
  })

  it('PUT returns 400 when hideFromRanking is not a boolean', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.put('/api/me').send({ hideFromRanking: 'yes' })
    expect(res.status).toBe(400)
  })
})
