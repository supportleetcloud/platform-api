import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

let mockAuthUserId = 'runs-routes-test-user'

jest.mock('passport', () => {
  const actual = jest.requireActual('passport')
  const originalAuthenticate = actual.authenticate.bind(actual)
  return Object.assign(actual, {
    authenticate: (strategy: string, ...args: any[]) => {
      if (strategy === 'session') {
        return originalAuthenticate(strategy, ...args)
      }
      return (req: any, _res: any, next: any) => {
        req.user = { id: mockAuthUserId, username: 'octocat', avatarUrl: null, isAdmin: false }
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
    mockAuthUserId = TEST_USER_ID
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

  it('rejects a missing challengeId with 400 instead of hanging or crashing', async () => {
    const fetchImpl = jest.fn() as any
    const app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/runs').send({
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })

    expect(res.status).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a non-string challengeId with 400 instead of hanging or crashing', async () => {
    const fetchImpl = jest.fn() as any
    const app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/runs').send({
      challengeId: { $ne: null },
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })

    expect(res.status).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
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

  it('returns 400 for an archived challenge, same as a nonexistent one', async () => {
    const archivedChallengeId = 'runs-routes-test-archived-challenge'
    await prisma.challenge.upsert({
      where: { id: archivedChallengeId },
      update: { archived: true },
      create: {
        id: archivedChallengeId,
        title: 'Archived',
        category: 'crud',
        points: 10,
        yamlPath: 'todo-api-crud.yaml',
        archived: true,
      },
    })

    const fetchImpl = jest.fn() as any
    const app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/runs').send({
      challengeId: archivedChallengeId,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })

    expect(res.status).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()

    await prisma.challenge.delete({ where: { id: archivedChallengeId } }).catch(() => {})
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

  it('shows feedback text to a paid user on an older run', async () => {
    await prisma.user.update({ where: { id: TEST_USER_ID }, data: { isPaid: true } })
    const olderRun = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 70,
        feedback: 'Older feedback text',
        feedbackStatus: 'ready',
        callbackToken: 'unused',
        createdAt: new Date(Date.now() - 60000),
      },
    })
    await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 90,
        feedback: 'Newer feedback text',
        feedbackStatus: 'ready',
        callbackToken: 'unused',
      },
    })

    const app = createApp({ prisma, fetchImpl: jest.fn() as any })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get(`/api/runs/${olderRun.id}`)
    expect(res.status).toBe(200)
    expect(res.body.feedback).toBe('Older feedback text')
    expect(res.body.feedbackLocked).toBe(false)

    await prisma.user.update({ where: { id: TEST_USER_ID }, data: { isPaid: false } })
  })

  it('locks feedback for a free user on anything but their most recent completed run', async () => {
    const olderRun = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 70,
        feedback: 'Older feedback text',
        feedbackStatus: 'ready',
        callbackToken: 'unused',
        createdAt: new Date(Date.now() - 60000),
      },
    })
    const newerRun = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 90,
        feedback: 'Newer feedback text',
        feedbackStatus: 'ready',
        callbackToken: 'unused',
      },
    })

    const app = createApp({ prisma, fetchImpl: jest.fn() as any })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const olderRes = await agent.get(`/api/runs/${olderRun.id}`)
    expect(olderRes.status).toBe(200)
    expect(olderRes.body.feedbackLocked).toBe(true)
    expect(olderRes.body.feedback).toBeNull()

    const newerRes = await agent.get(`/api/runs/${newerRun.id}`)
    expect(newerRes.status).toBe(200)
    expect(newerRes.body.feedbackLocked).toBe(false)
    expect(newerRes.body.feedback).toBe('Newer feedback text')
  })

  it('does not lock an older run for a free user when there is no feedback to unlock', async () => {
    const olderRun = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 70,
        feedbackStatus: 'not_applicable',
        callbackToken: 'unused',
        createdAt: new Date(Date.now() - 60000),
      },
    })
    await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 90,
        feedback: 'Newer feedback text',
        feedbackStatus: 'ready',
        callbackToken: 'unused',
      },
    })

    const app = createApp({ prisma, fetchImpl: jest.fn() as any })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get(`/api/runs/${olderRun.id}`)
    expect(res.status).toBe(200)
    expect(res.body.feedbackStatus).toBe('not_applicable')
    expect(res.body.feedbackLocked).toBe(false)
    expect(res.body.feedback).toBeNull()
  })

  it('reports a failed feedbackStatus for a stale pending-feedback run without changing the stored value', async () => {
    const staleDate = new Date(Date.now() - 2 * 60 * 1000)
    const run = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 80,
        feedbackStatus: 'pending',
        callbackToken: 'unused',
        updatedAt: staleDate,
      },
    })

    const app = createApp({ prisma, fetchImpl: jest.fn() as any })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get(`/api/runs/${run.id}`)
    expect(res.status).toBe(200)
    expect(res.body.feedbackStatus).toBe('failed')

    const stored = await prisma.run.findUnique({ where: { id: run.id } })
    expect(stored?.feedbackStatus).toBe('pending')
  })
})

describe('POST /api/runs — ToS gate', () => {
  const TOS_GATE_USER_ID = 'runs-routes-tos-gate-test-user'

  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TOS_GATE_USER_ID },
      update: { isPaid: false },
      create: { id: TOS_GATE_USER_ID, githubId: 'gh-runs-routes-tos-gate-test', username: 'octocat', isPaid: false },
    })
  })

  afterEach(async () => {
    await prisma.run.deleteMany({ where: { userId: TOS_GATE_USER_ID } })
    await prisma.tosAcceptance.deleteMany({})
    await prisma.tosVersion.deleteMany({})
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: TOS_GATE_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('returns 403 tos_required when a version is published and the user has not accepted it', async () => {
    await prisma.tosVersion.create({ data: { content: 'v1' } })
    const fetchImpl = jest.fn() as any
    const app = createApp({ prisma, fetchImpl })

    // The mocked `passport` strategy above always logs in as TEST_USER_ID from the
    // outer describe blocks in this file — override it here, before login, to exercise
    // a user with no acceptance on file. Passport's serializeUser captures the id into
    // the session during the /auth/github/callback call below, so mockAuthUserId must
    // be set before that call, not after — setting it after has no effect on this agent.
    mockAuthUserId = TOS_GATE_USER_ID
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/runs').send({
      challengeId: CHALLENGE_ID,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'tos_required' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allows submission once the user has accepted the current version', async () => {
    const version = await prisma.tosVersion.create({ data: { content: 'v1' } })
    mockAuthUserId = TOS_GATE_USER_ID
    await prisma.tosAcceptance.create({ data: { userId: TOS_GATE_USER_ID, tosVersionId: version.id } })

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
  })
})
