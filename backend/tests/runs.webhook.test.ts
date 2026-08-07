import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

const prisma = new PrismaClient()
const TEST_USER_ID = 'webhook-test-user'
const CHALLENGE_ID = 'webhook-test-challenge'

async function createPendingRun(id: string, token: string) {
  return prisma.run.create({
    data: {
      id,
      userId: TEST_USER_ID,
      challengeId: CHALLENGE_ID,
      targetUrl: 'https://candidate.example.com',
      status: 'pending',
      callbackToken: token,
    },
  })
}

describe('POST /api/webhooks/runs/:jobId', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, githubId: 'gh-webhook-test', username: 'octocat' },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_ID },
      update: {},
      create: { id: CHALLENGE_ID, title: 'Webhook Test', category: 'crud', points: 10, yamlPath: 'todo-api-crud.yaml' },
    })
  })

  afterEach(async () => {
    await prisma.run.deleteMany({ where: { userId: TEST_USER_ID } })
  })

  afterAll(async () => {
    await prisma.challenge.delete({ where: { id: CHALLENGE_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('returns 404 for an unknown jobId', async () => {
    const app = createApp({ prisma })
    const res = await request(app)
      .post('/api/webhooks/runs/does-not-exist?token=x')
      .send({ status: 'completed' })
    expect(res.status).toBe(404)
  })

  it('returns 403 when the token does not match, and leaves the Run untouched', async () => {
    await createPendingRun('webhook-test-run-1', 'correct-token')
    const app = createApp({ prisma })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-1?token=wrong-token')
      .send({ status: 'completed', score: 100, checks: [] })

    expect(res.status).toBe(403)

    const run = await prisma.run.findUnique({ where: { id: 'webhook-test-run-1' } })
    expect(run?.status).toBe('pending')
  })

  it('updates the Run to completed with the correct token', async () => {
    await createPendingRun('webhook-test-run-2', 'correct-token')
    const app = createApp({ prisma })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-2?token=correct-token')
      .send({
        status: 'completed',
        score: 85,
        checks: [{ name: 'check', status: 'passed', points: 10, pointsEarned: 10, assertions: [] }],
      })

    expect(res.status).toBe(200)

    const run = await prisma.run.findUnique({ where: { id: 'webhook-test-run-2' } })
    expect(run?.status).toBe('completed')
    expect(run?.score).toBe(85)
    expect(run?.checks).toEqual([
      { name: 'check', status: 'passed', points: 10, pointsEarned: 10, assertions: [] },
    ])
  })

  it('updates the Run to error with the error message', async () => {
    await createPendingRun('webhook-test-run-3', 'correct-token')
    const app = createApp({ prisma })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-3?token=correct-token')
      .send({ status: 'error', error: 'challenge YAML failed to parse' })

    expect(res.status).toBe(200)

    const run = await prisma.run.findUnique({ where: { id: 'webhook-test-run-3' } })
    expect(run?.status).toBe('error')
    expect(run?.error).toBe('challenge YAML failed to parse')
  })

  it('is idempotent — a second callback for an already-resolved run is a no-op', async () => {
    await createPendingRun('webhook-test-run-4', 'correct-token')
    const app = createApp({ prisma })

    await request(app)
      .post('/api/webhooks/runs/webhook-test-run-4?token=correct-token')
      .send({ status: 'completed', score: 50, checks: [] })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-4?token=correct-token')
      .send({ status: 'error', error: 'should not overwrite' })

    expect(res.status).toBe(200)

    const run = await prisma.run.findUnique({ where: { id: 'webhook-test-run-4' } })
    expect(run?.status).toBe('completed')
    expect(run?.score).toBe(50)
  })

  it('rejects an invalid status value', async () => {
    await createPendingRun('webhook-test-run-5', 'correct-token')
    const app = createApp({ prisma })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-5?token=correct-token')
      .send({ status: 'bogus' })

    expect(res.status).toBe(400)
  })

  it('marks feedbackStatus pending on a completed callback and responds before feedback generation finishes', async () => {
    await prisma.llmSettings.upsert({
      where: { id: 'singleton' },
      update: { provider: 'ollama', model: 'llama3.1', baseUrl: 'http://ollama.test', apiKeyEncrypted: null },
      create: {
        id: 'singleton',
        provider: 'ollama',
        model: 'llama3.1',
        baseUrl: 'http://ollama.test',
        apiKeyEncrypted: null,
      },
    })
    await createPendingRun('webhook-test-run-6', 'correct-token')

    let resolveFeedbackCall: (value: { ok: boolean; json: () => Promise<unknown> }) => void = () => {}
    const slowFeedbackCall = new Promise((resolve) => {
      resolveFeedbackCall = resolve as typeof resolveFeedbackCall
    })
    const fetchImpl = jest.fn().mockImplementation(() => slowFeedbackCall)
    const app = createApp({ prisma, fetchImpl })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-6?token=correct-token')
      .send({ status: 'completed', score: 90, checks: [] })

    expect(res.status).toBe(200)

    const run = await prisma.run.findUnique({ where: { id: 'webhook-test-run-6' } })
    expect(run?.status).toBe('completed')
    expect(run?.feedbackStatus).toBe('pending')

    resolveFeedbackCall({ ok: true, json: async () => ({ response: 'Nice work.' }) })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const resolved = await prisma.run.findUnique({ where: { id: 'webhook-test-run-6' } })
    expect(resolved?.feedbackStatus).toBe('ready')
    expect(resolved?.feedback).toBe('Nice work.')

    await prisma.llmSettings.deleteMany({})
  })

  it('leaves feedbackStatus not_applicable and never calls the LLM on an error callback', async () => {
    await createPendingRun('webhook-test-run-7', 'correct-token')
    const fetchImpl = jest.fn()
    const app = createApp({ prisma, fetchImpl })

    const res = await request(app)
      .post('/api/webhooks/runs/webhook-test-run-7?token=correct-token')
      .send({ status: 'error', error: 'boom' })

    expect(res.status).toBe(200)
    const run = await prisma.run.findUnique({ where: { id: 'webhook-test-run-7' } })
    expect(run?.feedbackStatus).toBe('not_applicable')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
