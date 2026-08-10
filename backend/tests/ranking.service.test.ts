import { PrismaClient } from '@prisma/client'
import { getRanking, getUserProfile } from '../src/ranking/service'

const prisma = new PrismaClient()

const USER_A = 'ranking-service-test-user-a'
const USER_B = 'ranking-service-test-user-b'
const USER_HIDDEN = 'ranking-service-test-user-hidden'
const CHALLENGE_1 = 'ranking-service-test-challenge-1'
const CHALLENGE_2 = 'ranking-service-test-challenge-2'

async function createRun(userId: string, challengeId: string, status: string, score: number | null) {
  await prisma.run.create({
    data: {
      userId,
      challengeId,
      targetUrl: 'https://example.test',
      status,
      score,
      callbackToken: 'test-token',
    },
  })
}

describe('ranking/service', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_A },
      update: { hideFromRanking: false },
      create: { id: USER_A, githubId: 'gh-ranking-a', username: 'alice-ranking-test', hideFromRanking: false },
    })
    await prisma.user.upsert({
      where: { id: USER_B },
      update: { hideFromRanking: false },
      create: { id: USER_B, githubId: 'gh-ranking-b', username: 'bob-ranking-test', hideFromRanking: false },
    })
    await prisma.user.upsert({
      where: { id: USER_HIDDEN },
      update: { hideFromRanking: true },
      create: { id: USER_HIDDEN, githubId: 'gh-ranking-hidden', username: 'hidden-ranking-test', hideFromRanking: true },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_1 },
      update: {},
      create: { id: CHALLENGE_1, title: 'Ranking Test Challenge One', category: 'crud', points: 25, yamlPath: 'x.yaml' },
    })
    await prisma.challenge.upsert({
      where: { id: CHALLENGE_2 },
      update: {},
      create: { id: CHALLENGE_2, title: 'Ranking Test Challenge Two', category: 'auth', points: 25, yamlPath: 'y.yaml' },
    })
  })

  afterEach(async () => {
    await prisma.run.deleteMany({ where: { userId: { in: [USER_A, USER_B, USER_HIDDEN] } } })
  })

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId: { in: [USER_A, USER_B, USER_HIDDEN] } } })
    await prisma.challenge.delete({ where: { id: CHALLENGE_1 } }).catch(() => {})
    await prisma.challenge.delete({ where: { id: CHALLENGE_2 } }).catch(() => {})
    await prisma.user.delete({ where: { id: USER_A } }).catch(() => {})
    await prisma.user.delete({ where: { id: USER_B } }).catch(() => {})
    await prisma.user.delete({ where: { id: USER_HIDDEN } }).catch(() => {})
    await prisma.$disconnect()
  })

  describe('getRanking', () => {
    it('sums the best score per challenge, ignoring non-completed runs', async () => {
      await createRun(USER_A, CHALLENGE_1, 'completed', 40)
      await createRun(USER_A, CHALLENGE_1, 'completed', 90) // best for challenge 1
      await createRun(USER_A, CHALLENGE_2, 'completed', 60)
      await createRun(USER_A, CHALLENGE_2, 'pending', null) // ignored
      await createRun(USER_A, CHALLENGE_2, 'error', null) // ignored

      const ranking = await getRanking(prisma)
      const entry = ranking.find((r) => r.userId === USER_A)

      expect(entry).toEqual({
        userId: USER_A,
        username: 'alice-ranking-test',
        avatarUrl: null,
        totalScore: 150, // 90 + 60
        challengesAttempted: 2,
      })
    })

    it('excludes a user with only non-completed runs', async () => {
      await createRun(USER_A, CHALLENGE_1, 'pending', null)

      const ranking = await getRanking(prisma)
      expect(ranking.find((r) => r.userId === USER_A)).toBeUndefined()
    })

    it('excludes a user with hideFromRanking: true even with completed runs', async () => {
      await createRun(USER_HIDDEN, CHALLENGE_1, 'completed', 100)

      const ranking = await getRanking(prisma)
      expect(ranking.find((r) => r.userId === USER_HIDDEN)).toBeUndefined()
    })

    it('sorts by totalScore desc, then username asc', async () => {
      await createRun(USER_A, CHALLENGE_1, 'completed', 50)
      await createRun(USER_B, CHALLENGE_1, 'completed', 80)

      const ranking = await getRanking(prisma)
      const ids = ranking.filter((r) => r.userId === USER_A || r.userId === USER_B).map((r) => r.userId)
      expect(ids).toEqual([USER_B, USER_A])
    })
  })

  describe('getUserProfile', () => {
    it('returns null for a nonexistent username', async () => {
      expect(await getUserProfile(prisma, 'no-such-user-ranking-test')).toBeNull()
    })

    it('returns null for a hidden user even though they exist', async () => {
      await createRun(USER_HIDDEN, CHALLENGE_1, 'completed', 100)
      expect(await getUserProfile(prisma, 'hidden-ranking-test')).toBeNull()
    })

    it('returns the challenge breakdown and rank for a visible user', async () => {
      await createRun(USER_A, CHALLENGE_1, 'completed', 40)
      await createRun(USER_A, CHALLENGE_1, 'completed', 90)
      await createRun(USER_A, CHALLENGE_2, 'completed', 60)
      await createRun(USER_B, CHALLENGE_1, 'completed', 10) // ranks below USER_A

      const profile = await getUserProfile(prisma, 'alice-ranking-test')

      expect(profile?.username).toBe('alice-ranking-test')
      expect(profile?.totalScore).toBe(150)
      expect(profile?.rank).toBe(1)
      expect(profile?.challenges).toEqual(
        expect.arrayContaining([
          { challengeId: CHALLENGE_1, title: 'Ranking Test Challenge One', category: 'crud', points: 25, bestScore: 90 },
          { challengeId: CHALLENGE_2, title: 'Ranking Test Challenge Two', category: 'auth', points: 25, bestScore: 60 },
        ])
      )
      expect(profile?.challenges).toHaveLength(2)
    })

    it('returns rank: 0 and an empty challenge list for a visible user with no completed runs', async () => {
      const profile = await getUserProfile(prisma, 'alice-ranking-test')

      expect(profile).toEqual({
        username: 'alice-ranking-test',
        avatarUrl: null,
        totalScore: 0,
        rank: 0,
        challenges: [],
      })
    })
  })
})
