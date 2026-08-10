import { PrismaClient } from '@prisma/client'
import {
  getCurrentVersion,
  listVersions,
  publishVersion,
  isTosAcceptanceRequired,
  acceptCurrentVersion,
} from '../src/tos/service'

const prisma = new PrismaClient()
const USER_ID = 'tos-service-test-user'

describe('tos/service', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, githubId: 'gh-tos-service-test', username: 'octocat' },
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

  describe('getCurrentVersion / listVersions', () => {
    it('returns null with zero versions', async () => {
      expect(await getCurrentVersion(prisma)).toBeNull()
      expect(await listVersions(prisma)).toEqual([])
    })

    it('returns the newest version by publishedAt', async () => {
      const older = await prisma.tosVersion.create({
        data: { content: 'v1', publishedAt: new Date('2026-01-01') },
      })
      const newer = await prisma.tosVersion.create({
        data: { content: 'v2', publishedAt: new Date('2026-02-01') },
      })

      const current = await getCurrentVersion(prisma)
      expect(current?.id).toBe(newer.id)

      const all = await listVersions(prisma)
      expect(all.map((v) => v.id)).toEqual([newer.id, older.id])
    })
  })

  describe('publishVersion', () => {
    it('rejects blank content', async () => {
      expect(await publishVersion(prisma, '')).toEqual({ kind: 'validation_error', error: 'content is required' })
      expect(await publishVersion(prisma, '   ')).toEqual({ kind: 'validation_error', error: 'content is required' })
    })

    it('creates a new version', async () => {
      const result = await publishVersion(prisma, 'Be excellent to each other.')
      expect(result.kind).toBe('published')
      if (result.kind === 'published') {
        expect(result.version.content).toBe('Be excellent to each other.')
      }
    })
  })

  describe('isTosAcceptanceRequired', () => {
    it('is false with no versions published', async () => {
      expect(await isTosAcceptanceRequired(prisma, USER_ID)).toBe(false)
    })

    it('is true once a version exists and the user has not accepted it', async () => {
      await prisma.tosVersion.create({ data: { content: 'v1' } })
      expect(await isTosAcceptanceRequired(prisma, USER_ID)).toBe(true)
    })

    it('is false after accepting the current version', async () => {
      const version = await prisma.tosVersion.create({ data: { content: 'v1' } })
      await prisma.tosAcceptance.create({ data: { userId: USER_ID, tosVersionId: version.id } })
      expect(await isTosAcceptanceRequired(prisma, USER_ID)).toBe(false)
    })

    it('is true again once a newer version is published', async () => {
      const older = await prisma.tosVersion.create({
        data: { content: 'v1', publishedAt: new Date('2026-01-01') },
      })
      await prisma.tosAcceptance.create({ data: { userId: USER_ID, tosVersionId: older.id } })
      await prisma.tosVersion.create({ data: { content: 'v2', publishedAt: new Date('2026-02-01') } })

      expect(await isTosAcceptanceRequired(prisma, USER_ID)).toBe(true)
    })
  })

  describe('acceptCurrentVersion', () => {
    it('returns not_configured with no versions published', async () => {
      const result = await acceptCurrentVersion(prisma, USER_ID, 'does-not-exist')
      expect(result).toEqual({ kind: 'not_configured' })
    })

    it('returns stale_version when the given id is not current', async () => {
      const older = await prisma.tosVersion.create({
        data: { content: 'v1', publishedAt: new Date('2026-01-01') },
      })
      await prisma.tosVersion.create({ data: { content: 'v2', publishedAt: new Date('2026-02-01') } })

      const result = await acceptCurrentVersion(prisma, USER_ID, older.id)
      expect(result).toEqual({ kind: 'stale_version' })
    })

    it('records acceptance and is idempotent on double-submit', async () => {
      const version = await prisma.tosVersion.create({ data: { content: 'v1' } })

      expect(await acceptCurrentVersion(prisma, USER_ID, version.id)).toEqual({ kind: 'accepted' })
      expect(await acceptCurrentVersion(prisma, USER_ID, version.id)).toEqual({ kind: 'accepted' })

      const count = await prisma.tosAcceptance.count({ where: { userId: USER_ID, tosVersionId: version.id } })
      expect(count).toBe(1)
    })
  })
})
