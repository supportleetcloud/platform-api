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
        req.user = { id: USER_ID, username: 'octocat', avatarUrl: null, isAdmin: false }
        req.login(req.user, (err: Error) => next(err))
      }
    },
  })
})

const prisma = new PrismaClient()
const USER_ID = 'tos-routes-test-user'

describe('GET /api/tos/current', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, githubId: 'gh-tos-routes-test', username: 'octocat' },
    })
  })

  afterEach(async () => {
    await prisma.tosAcceptance.deleteMany({})
    await prisma.tosVersion.deleteMany({})
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('returns 401 when not authenticated', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/tos/current')
    expect(res.status).toBe(401)
  })

  it('returns 404 before any publish', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/tos/current')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'tos_not_configured' })
  })

  it('returns the current version after a publish', async () => {
    const version = await prisma.tosVersion.create({ data: { content: 'Be excellent to each other.' } })
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/tos/current')
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(version.id)
    expect(res.body.content).toBe('Be excellent to each other.')
  })
})

describe('POST /api/tos/accept', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, githubId: 'gh-tos-routes-test', username: 'octocat' },
    })
  })

  afterEach(async () => {
    await prisma.tosAcceptance.deleteMany({})
    await prisma.tosVersion.deleteMany({})
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('returns 401 when not authenticated', async () => {
    const app = createApp({ prisma })
    const res = await request(app).post('/api/tos/accept').send({ tosVersionId: 'whatever' })
    expect(res.status).toBe(401)
  })

  it('returns 400 when tosVersionId is missing', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/tos/accept').send({})
    expect(res.status).toBe(400)
  })

  it('returns 404 when no version has been published', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/tos/accept').send({ tosVersionId: 'does-not-exist' })
    expect(res.status).toBe(404)
  })

  it('returns 409 for a stale version id', async () => {
    const older = await prisma.tosVersion.create({
      data: { content: 'v1', publishedAt: new Date('2026-01-01') },
    })
    await prisma.tosVersion.create({ data: { content: 'v2', publishedAt: new Date('2026-02-01') } })
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/tos/accept').send({ tosVersionId: older.id })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'stale_version' })
  })

  it('accepts the current version', async () => {
    const version = await prisma.tosVersion.create({ data: { content: 'v1' } })
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/tos/accept').send({ tosVersionId: version.id })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const stored = await prisma.tosAcceptance.findUnique({
      where: { userId_tosVersionId: { userId: USER_ID, tosVersionId: version.id } },
    })
    expect(stored).not.toBeNull()
  })
})
