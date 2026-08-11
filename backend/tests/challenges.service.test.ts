import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as yaml from 'js-yaml'
import { PrismaClient } from '@prisma/client'
import {
  parseChallengeYaml,
  sumPoints,
  seedChallengesFromDirectory,
  createChallenge,
  updateChallenge,
  setChallengeArchived,
  listAdminChallenges,
  getAdminChallenge,
  buildChallengeYaml,
} from '../src/challenges/service'

const prisma = new PrismaClient()

const FIXTURE_YAML = `
id: fixture-challenge
title: "Fixture Challenge"
category: crud
checks:
  - name: "step one"
    request:
      method: GET
      path: /ping
    expect:
      status: 200
    points: 10
  - name: "step two"
    request:
      method: GET
      path: /pong
    expect:
      status: 200
    points: 15
`

describe('parseChallengeYaml / sumPoints', () => {
  it('parses id/title/category/checks and sums points', () => {
    const parsed = parseChallengeYaml(FIXTURE_YAML)
    expect(parsed.id).toBe('fixture-challenge')
    expect(parsed.title).toBe('Fixture Challenge')
    expect(parsed.category).toBe('crud')
    expect(sumPoints(parsed.checks)).toBe(25)
  })
})

describe('seedChallengesFromDirectory', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenges-test-'))
    fs.writeFileSync(path.join(dir, 'fixture-challenge.yaml'), FIXTURE_YAML)
  })

  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true })
    await prisma.challenge.deleteMany({ where: { id: 'fixture-challenge' } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('upserts a Challenge row per YAML file', async () => {
    await seedChallengesFromDirectory(prisma, dir)

    const challenge = await prisma.challenge.findUnique({ where: { id: 'fixture-challenge' } })
    expect(challenge).not.toBeNull()
    expect(challenge?.title).toBe('Fixture Challenge')
    expect(challenge?.category).toBe('crud')
    expect(challenge?.points).toBe(25)
    expect(challenge?.yamlPath).toBe('fixture-challenge.yaml')
  })

  it('is idempotent — re-running does not duplicate or error', async () => {
    await seedChallengesFromDirectory(prisma, dir)
    await seedChallengesFromDirectory(prisma, dir)

    const count = await prisma.challenge.count({ where: { id: 'fixture-challenge' } })
    expect(count).toBe(1)
  })
})

describe('admin challenge CRUD', () => {
  afterEach(async () => {
    await prisma.challengeCheck.deleteMany({ where: { challenge: { title: { startsWith: 'Admin CRUD Test' } } } })
    await prisma.challenge.deleteMany({ where: { title: { startsWith: 'Admin CRUD Test' } } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  const VALID_INPUT = {
    title: 'Admin CRUD Test Challenge',
    description: 'A test challenge',
    objective: 'Prove the CRUD works',
    technicalDetails: 'Uses a fake API',
    category: 'crud',
    checks: [
      {
        name: 'GET /ping',
        method: 'GET',
        path: '/ping',
        expectStatus: 200,
        points: 10,
      },
      {
        name: 'POST /echo',
        method: 'POST',
        path: '/echo',
        requestBody: { hello: 'world' },
        expectStatus: 201,
        expectJson: { hello: 'world' },
        expectHeaders: { 'Content-Type': 'application/json' },
        points: 15,
      },
    ],
  }

  describe('createChallenge', () => {
    it('rejects a blank title', async () => {
      const result = await createChallenge(prisma, { ...VALID_INPUT, title: '' })
      expect(result).toEqual({ kind: 'validation_error', error: 'title is required' })
    })

    it('rejects an unknown category', async () => {
      const result = await createChallenge(prisma, { ...VALID_INPUT, category: 'bogus' })
      expect(result.kind).toBe('validation_error')
      if (result.kind === 'validation_error') {
        expect(result.error).toContain('category must be one of')
      }
    })

    it('rejects zero checks', async () => {
      const result = await createChallenge(prisma, { ...VALID_INPUT, checks: [] })
      expect(result).toEqual({ kind: 'validation_error', error: 'at least one request type is required' })
    })

    it('rejects a check with a path that does not start with /', async () => {
      const result = await createChallenge(prisma, {
        ...VALID_INPUT,
        checks: [{ ...VALID_INPUT.checks[0], path: 'ping' }],
      })
      expect(result.kind).toBe('validation_error')
      if (result.kind === 'validation_error') {
        expect(result.error).toBe('check 1: path must start with /')
      }
    })

    it('rejects a check with a non-positive points value', async () => {
      const result = await createChallenge(prisma, {
        ...VALID_INPUT,
        checks: [{ ...VALID_INPUT.checks[0], points: 0 }],
      })
      expect(result.kind).toBe('validation_error')
      if (result.kind === 'validation_error') {
        expect(result.error).toBe('check 1: points must be a positive integer')
      }
    })

    it('creates the challenge, sums points, and creates ordered checks', async () => {
      const result = await createChallenge(prisma, VALID_INPUT)
      expect(result.kind).toBe('saved')
      if (result.kind !== 'saved') return

      const challenge = await prisma.challenge.findUnique({ where: { id: result.challengeId } })
      expect(challenge?.points).toBe(25)
      expect(challenge?.yamlPath).toBeNull()
      expect(challenge?.archived).toBe(false)

      const checks = await prisma.challengeCheck.findMany({
        where: { challengeId: result.challengeId },
        orderBy: { order: 'asc' },
      })
      expect(checks).toHaveLength(2)
      expect(checks[0].name).toBe('GET /ping')
      expect(checks[0].order).toBe(0)
      expect(checks[1].name).toBe('POST /echo')
      expect(checks[1].order).toBe(1)
      expect(checks[1].requestBody).toEqual({ hello: 'world' })
    })
  })

  describe('updateChallenge', () => {
    it('returns not_found for a nonexistent id', async () => {
      const result = await updateChallenge(prisma, 'admin-crud-test-does-not-exist', VALID_INPUT)
      expect(result).toEqual({ kind: 'not_found' })
    })

    it('returns file_defined for a file-seeded challenge', async () => {
      const fileChallenge = await prisma.challenge.create({
        data: { title: 'Admin CRUD Test File Challenge', category: 'crud', points: 10, yamlPath: 'todo-api-crud.yaml' },
      })
      const result = await updateChallenge(prisma, fileChallenge.id, VALID_INPUT)
      expect(result).toEqual({ kind: 'file_defined' })
    })

    it('replaces the check set and recomputes points', async () => {
      const created = await createChallenge(prisma, VALID_INPUT)
      if (created.kind !== 'saved') throw new Error('setup failed')

      const result = await updateChallenge(prisma, created.challengeId, {
        ...VALID_INPUT,
        title: 'Admin CRUD Test Challenge (updated)',
        checks: [{ name: 'DELETE /reset', method: 'DELETE', path: '/reset', expectStatus: 204, points: 5 }],
      })
      expect(result).toEqual({ kind: 'saved', challengeId: created.challengeId })

      const challenge = await prisma.challenge.findUnique({ where: { id: created.challengeId } })
      expect(challenge?.title).toBe('Admin CRUD Test Challenge (updated)')
      expect(challenge?.points).toBe(5)

      const checks = await prisma.challengeCheck.findMany({ where: { challengeId: created.challengeId } })
      expect(checks).toHaveLength(1)
      expect(checks[0].name).toBe('DELETE /reset')
    })
  })

  describe('setChallengeArchived', () => {
    it('returns not_found for a nonexistent id', async () => {
      const result = await setChallengeArchived(prisma, 'admin-crud-test-does-not-exist', true)
      expect(result).toEqual({ kind: 'not_found' })
    })

    it('toggles archived', async () => {
      const created = await createChallenge(prisma, VALID_INPUT)
      if (created.kind !== 'saved') throw new Error('setup failed')

      expect(await setChallengeArchived(prisma, created.challengeId, true)).toEqual({ kind: 'updated' })
      let challenge = await prisma.challenge.findUnique({ where: { id: created.challengeId } })
      expect(challenge?.archived).toBe(true)

      expect(await setChallengeArchived(prisma, created.challengeId, false)).toEqual({ kind: 'updated' })
      challenge = await prisma.challenge.findUnique({ where: { id: created.challengeId } })
      expect(challenge?.archived).toBe(false)
    })
  })

  describe('listAdminChallenges / getAdminChallenge', () => {
    it('lists both file-seeded and database-defined challenges, labeling their source', async () => {
      const fileChallenge = await prisma.challenge.create({
        data: { title: 'Admin CRUD Test File Challenge', category: 'crud', points: 10, yamlPath: 'todo-api-crud.yaml' },
      })
      const created = await createChallenge(prisma, VALID_INPUT)
      if (created.kind !== 'saved') throw new Error('setup failed')

      const list = await listAdminChallenges(prisma)
      const fileEntry = list.find((c) => c.id === fileChallenge.id)
      const dbEntry = list.find((c) => c.id === created.challengeId)
      expect(fileEntry?.source).toBe('file')
      expect(dbEntry?.source).toBe('database')
    })

    it('getAdminChallenge returns full detail with ordered checks, or null', async () => {
      expect(await getAdminChallenge(prisma, 'admin-crud-test-does-not-exist')).toBeNull()

      const created = await createChallenge(prisma, VALID_INPUT)
      if (created.kind !== 'saved') throw new Error('setup failed')

      const detail = await getAdminChallenge(prisma, created.challengeId)
      expect(detail?.title).toBe('Admin CRUD Test Challenge')
      expect(detail?.source).toBe('database')
      expect(detail?.checks).toHaveLength(2)
      expect(detail?.checks[0].name).toBe('GET /ping')
      expect(detail?.checks[1].requestBody).toEqual({ hello: 'world' })
    })
  })
})

describe('buildChallengeYaml', () => {
  it('produces YAML that parses back to the same shape via parseChallengeYaml', () => {
    const yamlText = buildChallengeYaml(
      { id: 'yaml-build-test', title: 'YAML Build Test', category: 'crud' },
      [
        {
          name: 'GET /ping',
          method: 'GET',
          path: '/ping',
          requestHeaders: null,
          requestBody: null,
          expectStatus: 200,
          expectJson: null,
          expectHeaders: null,
          points: 10,
        },
        {
          name: 'POST /echo',
          method: 'POST',
          path: '/echo',
          requestHeaders: { 'X-Test': 'yes' },
          requestBody: { hello: 'world' },
          expectStatus: 201,
          expectJson: { hello: 'world' },
          expectHeaders: null,
          points: 15,
        },
      ]
    )

    const parsed = parseChallengeYaml(yamlText)
    expect(parsed.id).toBe('yaml-build-test')
    expect(parsed.title).toBe('YAML Build Test')
    expect(parsed.category).toBe('crud')
    expect(sumPoints(parsed.checks)).toBe(25)

    // Optional fields: omitted entirely when null, present when set — parse the raw YAML
    // object (not just the ChallengeCheckSpec-typed view) to check the exact shape.
    const raw = yaml.load(yamlText) as any
    expect(raw.checks[0].request).toEqual({ method: 'GET', path: '/ping' })
    expect(raw.checks[0].request.headers).toBeUndefined()
    expect(raw.checks[0].request.body).toBeUndefined()
    expect(raw.checks[1].request.headers).toEqual({ 'X-Test': 'yes' })
    expect(raw.checks[1].expect.json).toEqual({ hello: 'world' })
  })
})
