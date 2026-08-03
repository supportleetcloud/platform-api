import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

jest.mock('passport', () => {
  const actual = jest.requireActual('passport')
  return Object.assign(actual, {
    authenticate: (_strategy: string, options: any = {}) => (req: any, res: any, next: any) => {
      if (_strategy === 'session') {
        // passport.session() middleware - deserialize user from passport.passport object
        if (req._passport?.instance) {
          const passport = req._passport.instance
          if (req.session?.passport?.user) {
            // Call deserializeUser to get the full user object
            // For testing, we just set the user directly since we're using a mocked flow
            req.user = { id: 'test-user-id', username: 'octocat', avatarUrl: null, isAdmin: true }
          }
        }
        return next()
      }

      const isCallback = req.path.includes('callback')
      if (isCallback) {
        req.user = { id: 'test-user-id', username: 'octocat', avatarUrl: null, isAdmin: true }
        req.login(req.user, (err: Error) => {
          if (err) {
            return next(err)
          }
          // After login, continue to the next handler which redirects to dashboard
          next()
        })
      } else {
        res.redirect('https://github.com/login/oauth/authorize')
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
