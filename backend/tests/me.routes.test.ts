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
    })
  })
})
