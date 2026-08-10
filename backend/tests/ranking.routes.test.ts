import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

const prisma = new PrismaClient()

const USER_ID = 'ranking-routes-test-user'
const CHALLENGE_ID = 'ranking-routes-test-challenge'

describe('GET /api/ranking', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { hideFromRanking: false },
      create: { id: USER_ID, githubId: 'gh-ranking-routes-test', username: 'ranking-routes-octocat', hideFromRanking: false },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_ID },
      update: {},
      create: { id: CHALLENGE_ID, title: 'Ranking Routes Test Challenge', category: 'crud', points: 25, yamlPath: 'x.yaml' },
    })
  })

  afterEach(async () => {
    await prisma.run.deleteMany({ where: { userId: USER_ID } })
  })

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId: USER_ID } })
    await prisma.challenge.delete({ where: { id: CHALLENGE_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('requires no authentication and returns 200 for an anonymous request', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/ranking')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  it('includes a user with a completed run', async () => {
    await prisma.run.create({
      data: {
        userId: USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://example.test',
        status: 'completed',
        score: 77,
        callbackToken: 'test-token',
      },
    })

    const app = createApp({ prisma })
    const res = await request(app).get('/api/ranking')

    const entry = res.body.find((r: any) => r.userId === USER_ID)
    expect(entry).toEqual({
      userId: USER_ID,
      username: 'ranking-routes-octocat',
      avatarUrl: null,
      totalScore: 77,
      challengesAttempted: 1,
    })
  })
})

describe('GET /api/users/:username/profile', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { hideFromRanking: false },
      create: { id: USER_ID, githubId: 'gh-ranking-routes-test', username: 'ranking-routes-octocat', hideFromRanking: false },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_ID },
      update: {},
      create: { id: CHALLENGE_ID, title: 'Ranking Routes Test Challenge', category: 'crud', points: 25, yamlPath: 'x.yaml' },
    })
  })

  afterEach(async () => {
    await prisma.run.deleteMany({ where: { userId: USER_ID } })
  })

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId: USER_ID } })
    await prisma.challenge.delete({ where: { id: CHALLENGE_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('returns 404 for a nonexistent username, no auth required', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/users/no-such-user-anywhere/profile')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'user_not_found' })
  })

  it('returns the profile for an existing, visible username', async () => {
    await prisma.run.create({
      data: {
        userId: USER_ID,
        challengeId: CHALLENGE_ID,
        targetUrl: 'https://example.test',
        status: 'completed',
        score: 88,
        callbackToken: 'test-token',
      },
    })

    const app = createApp({ prisma })
    const res = await request(app).get('/api/users/ranking-routes-octocat/profile')

    expect(res.status).toBe(200)
    expect(res.body.username).toBe('ranking-routes-octocat')
    expect(res.body.totalScore).toBe(88)
    expect(res.body.challenges).toHaveLength(1)
    expect(res.body.challenges[0]).toEqual({
      challengeId: CHALLENGE_ID,
      title: 'Ranking Routes Test Challenge',
      category: 'crud',
      points: 25,
      bestScore: 88,
    })
  })

  it('returns 404 for a hidden user, same shape as nonexistent', async () => {
    await prisma.user.update({ where: { id: USER_ID }, data: { hideFromRanking: true } })

    const app = createApp({ prisma })
    const res = await request(app).get('/api/users/ranking-routes-octocat/profile')

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'user_not_found' })

    await prisma.user.update({ where: { id: USER_ID }, data: { hideFromRanking: false } })
  })
})
