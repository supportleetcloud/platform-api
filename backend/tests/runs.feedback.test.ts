import { PrismaClient } from '@prisma/client'
import { generateFeedbackForRun } from '../src/runs/feedback'
import { saveLlmSettings } from '../src/llm/settings'

const prisma = new PrismaClient()
const TEST_USER_ID = 'feedback-test-user'
const CHALLENGE_ID = 'feedback-test-challenge'

describe('generateFeedbackForRun', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, githubId: 'gh-feedback-test', username: 'octocat' },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_ID },
      update: {},
      create: {
        id: CHALLENGE_ID,
        title: 'Feedback Test Challenge',
        category: 'crud',
        points: 25,
        yamlPath: 'todo-api-crud.yaml',
      },
    })
  })

  afterEach(async () => {
    await prisma.run.deleteMany({ where: { userId: TEST_USER_ID } })
    await prisma.llmSettings.deleteMany({})
  })

  afterAll(async () => {
    await prisma.challenge.delete({ where: { id: CHALLENGE_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('sets feedback and feedbackStatus=ready on a successful provider call', async () => {
    await saveLlmSettings(prisma, { provider: 'claude', model: 'claude-sonnet-5', apiKey: 'sk-test' })
    const run = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 85,
        checks: [{ name: 'check', status: 'passed', points: 10, pointsEarned: 10 }],
        feedbackStatus: 'pending',
        callbackToken: 'unused',
      },
    })
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ text: 'Great job!' }] }),
    }) as any

    await generateFeedbackForRun(prisma, fetchImpl, run.id)

    const updated = await prisma.run.findUnique({ where: { id: run.id } })
    expect(updated?.feedbackStatus).toBe('ready')
    expect(updated?.feedback).toBe('Great job!')
  })

  it('sets feedbackStatus=failed when no LlmSettings are configured', async () => {
    const run = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 50,
        checks: [],
        feedbackStatus: 'pending',
        callbackToken: 'unused',
      },
    })
    const fetchImpl = jest.fn() as any

    await generateFeedbackForRun(prisma, fetchImpl, run.id)

    const updated = await prisma.run.findUnique({ where: { id: run.id } })
    expect(updated?.feedbackStatus).toBe('failed')
    expect(updated?.feedback).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sets feedbackStatus=failed when the provider call throws', async () => {
    await saveLlmSettings(prisma, { provider: 'claude', model: 'claude-sonnet-5', apiKey: 'sk-test' })
    const run = await prisma.run.create({
      data: {
        userId: TEST_USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://candidate.example.com',
        status: 'completed',
        score: 20,
        checks: [],
        feedbackStatus: 'pending',
        callbackToken: 'unused',
      },
    })
    const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as any

    await generateFeedbackForRun(prisma, fetchImpl, run.id)

    const updated = await prisma.run.findUnique({ where: { id: run.id } })
    expect(updated?.feedbackStatus).toBe('failed')
    expect(updated?.feedback).toBeNull()
  })
})
