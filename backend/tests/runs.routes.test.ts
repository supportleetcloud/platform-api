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
