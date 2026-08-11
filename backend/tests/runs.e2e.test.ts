import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import * as yaml from 'js-yaml'
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

const TEST_USER_ID = 'e2e-test-user'
const CHALLENGE_ID = 'e2e-test-challenge'
const prisma = new PrismaClient()

describe('run submission end-to-end', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, githubId: 'gh-e2e-test', username: 'octocat' },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_ID },
      update: {},
      create: { id: CHALLENGE_ID, title: 'E2E Todo CRUD', category: 'crud', points: 25, yamlPath: 'todo-api-crud.yaml' },
    })
  })

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId: TEST_USER_ID } })
    await prisma.challenge.delete({ where: { id: CHALLENGE_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('submit -> webhook callback -> poll reflects the final score', async () => {
    let app: ReturnType<typeof createApp>

    // Stands in for the Java validation engine: instead of really calling out to it, fires
    // the same callback a real run would make, against this same app instance — proving the
    // webhookUrl/token this app constructs is one this app's own webhook route accepts.
    const fetchImpl = jest.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      const webhookUrl = new URL(body.webhookUrl)
      await request(app)
        .post(webhookUrl.pathname + webhookUrl.search)
        .send({
          status: 'completed',
          score: 100,
          checks: [
            { name: 'POST /todos creates a todo', status: 'passed', points: 10, pointsEarned: 10, assertions: [] },
          ],
        })
      return { ok: true, status: 202 } as Response
    }) as any

    app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const submitRes = await agent.post('/api/runs').send({
      challengeId: CHALLENGE_ID,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })
    expect(submitRes.status).toBe(202)

    const pollRes = await agent.get(`/api/runs/${submitRes.body.runId}`)
    expect(pollRes.status).toBe(200)
    expect(pollRes.body.status).toBe('completed')
    expect(pollRes.body.score).toBe(100)
    expect(pollRes.body.checks).toHaveLength(1)
  })

  it('submits against a database-defined challenge by serializing its checks to YAML', async () => {
    const dbChallenge = await prisma.challenge.create({
      data: {
        title: 'E2E DB-Defined Challenge',
        category: 'crud',
        points: 10,
        yamlPath: null,
      },
    })
    await prisma.challengeCheck.create({
      data: {
        challengeId: dbChallenge.id,
        name: 'GET /ping',
        method: 'GET',
        path: '/ping',
        expectStatus: 200,
        points: 10,
        order: 0,
      },
    })

    let app: ReturnType<typeof createApp>
    let capturedYaml = ''

    const fetchImpl = jest.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      capturedYaml = body.challengeYaml
      const webhookUrl = new URL(body.webhookUrl)
      await request(app)
        .post(webhookUrl.pathname + webhookUrl.search)
        .send({
          status: 'completed',
          score: 10,
          checks: [{ name: 'GET /ping', status: 'passed', points: 10, pointsEarned: 10, assertions: [] }],
        })
      return { ok: true, status: 202 } as Response
    }) as any

    app = createApp({ prisma, fetchImpl })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const submitRes = await agent.post('/api/runs').send({
      challengeId: dbChallenge.id,
      targetUrl: 'https://candidate.example.com',
      confirmedAuthorization: true,
    })
    expect(submitRes.status).toBe(202)

    const parsedYaml = yaml.load(capturedYaml) as any
    expect(parsedYaml.id).toBe(dbChallenge.id)
    expect(parsedYaml.title).toBe('E2E DB-Defined Challenge')
    expect(parsedYaml.checks).toHaveLength(1)
    expect(parsedYaml.checks[0].request).toEqual({ method: 'GET', path: '/ping' })
    expect(parsedYaml.checks[0].expect).toEqual({ status: 200 })

    const pollRes = await agent.get(`/api/runs/${submitRes.body.runId}`)
    expect(pollRes.body.status).toBe('completed')
    expect(pollRes.body.score).toBe(10)

    await prisma.run.deleteMany({ where: { challengeId: dbChallenge.id } })
    await prisma.challengeCheck.deleteMany({ where: { challengeId: dbChallenge.id } })
    await prisma.challenge.delete({ where: { id: dbChallenge.id } }).catch(() => {})
  })
})
