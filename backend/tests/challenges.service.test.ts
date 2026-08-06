import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { PrismaClient } from '@prisma/client'
import {
  parseChallengeYaml,
  sumPoints,
  seedChallengesFromDirectory,
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
