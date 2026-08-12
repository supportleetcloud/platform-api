import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { PrismaClient } from '@prisma/client'

export const CHALLENGES_DIR = path.join(__dirname, '..', '..', 'challenges')

export type ChallengeCheckSpec = {
  points: number
}

export type ParsedChallengeYaml = {
  id: string
  title: string
  category: string
  checks: ChallengeCheckSpec[]
}

export function parseChallengeYaml(yamlText: string): ParsedChallengeYaml {
  return yaml.load(yamlText) as ParsedChallengeYaml
}

export function sumPoints(checks: ChallengeCheckSpec[]): number {
  return checks.reduce((total, check) => total + check.points, 0)
}

export async function seedChallengesFromDirectory(
  prisma: PrismaClient,
  challengesDir: string
): Promise<void> {
  const files = fs.readdirSync(challengesDir).filter((file) => file.endsWith('.yaml'))

  for (const file of files) {
    const yamlText = fs.readFileSync(path.join(challengesDir, file), 'utf-8')
    const parsed = parseChallengeYaml(yamlText)
    const points = sumPoints(parsed.checks)

    await prisma.challenge.upsert({
      where: { id: parsed.id },
      update: { title: parsed.title, category: parsed.category, points, yamlPath: file },
      create: { id: parsed.id, title: parsed.title, category: parsed.category, points, yamlPath: file },
    })
  }
}

const KNOWN_CATEGORIES = ['crud', 'contract', 'status', 'auth']

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyStringValues(value: Record<string, unknown>): boolean {
  return Object.values(value).every((v) => typeof v === 'string')
}

export type ChallengeCheckInput = {
  name: string
  method: string
  path: string
  requestHeaders?: Record<string, string>
  requestBody?: unknown
  expectStatus: number
  expectJson?: unknown
  expectHeaders?: Record<string, string>
  points: number
}

export type ChallengeInput = {
  title: string
  description?: string
  objective?: string
  technicalDetails?: string
  category: string
  checks: ChallengeCheckInput[]
}

function validateChallengeInput(input: ChallengeInput): string | null {
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    return 'title is required'
  }
  if (!KNOWN_CATEGORIES.includes(input.category)) {
    return `category must be one of: ${KNOWN_CATEGORIES.join(', ')}`
  }
  if (!Array.isArray(input.checks) || input.checks.length === 0) {
    return 'at least one request type is required'
  }
  for (let i = 0; i < input.checks.length; i++) {
    const check = input.checks[i]
    const label = `check ${i + 1}`
    if (typeof check.name !== 'string' || check.name.trim().length === 0) {
      return `${label}: name is required`
    }
    if (typeof check.method !== 'string' || check.method.trim().length === 0) {
      return `${label}: method is required`
    }
    if (typeof check.path !== 'string' || !check.path.startsWith('/')) {
      return `${label}: path must start with /`
    }
    if (!Number.isInteger(check.expectStatus) || check.expectStatus < 100 || check.expectStatus > 599) {
      return `${label}: expectStatus must be an integer between 100 and 599`
    }
    if (!Number.isInteger(check.points) || check.points <= 0) {
      return `${label}: points must be a positive integer`
    }
    if (check.requestBody !== undefined && !isJsonObject(check.requestBody)) {
      return `${label}: requestBody must be a JSON object`
    }
    if (check.expectJson !== undefined && !isJsonObject(check.expectJson)) {
      return `${label}: expectJson must be a JSON object`
    }
    if (check.requestHeaders !== undefined) {
      if (!isJsonObject(check.requestHeaders) || !hasOnlyStringValues(check.requestHeaders)) {
        return `${label}: requestHeaders must be a JSON object with string values`
      }
    }
    if (check.expectHeaders !== undefined) {
      if (!isJsonObject(check.expectHeaders) || !hasOnlyStringValues(check.expectHeaders)) {
        return `${label}: expectHeaders must be a JSON object with string values`
      }
    }
  }
  return null
}

function checkCreateData(challengeId: string, checks: ChallengeCheckInput[]) {
  return checks.map((check, index) => ({
    challengeId,
    name: check.name,
    method: check.method,
    path: check.path,
    requestHeaders: check.requestHeaders ?? undefined,
    requestBody: check.requestBody ?? undefined,
    expectStatus: check.expectStatus,
    expectJson: check.expectJson ?? undefined,
    expectHeaders: check.expectHeaders ?? undefined,
    points: check.points,
    order: index,
  }))
}

export type SaveChallengeResult =
  | { kind: 'saved'; challengeId: string }
  | { kind: 'validation_error'; error: string }
  | { kind: 'not_found' }
  | { kind: 'file_defined' }

export async function createChallenge(prisma: PrismaClient, input: ChallengeInput): Promise<SaveChallengeResult> {
  const validationError = validateChallengeInput(input)
  if (validationError) {
    return { kind: 'validation_error', error: validationError }
  }

  const points = sumPoints(input.checks)
  const challenge = await prisma.$transaction(async (tx) => {
    const created = await tx.challenge.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        objective: input.objective ?? null,
        technicalDetails: input.technicalDetails ?? null,
        category: input.category,
        points,
        yamlPath: null,
      },
    })
    await tx.challengeCheck.createMany({ data: checkCreateData(created.id, input.checks) })
    return created
  })

  return { kind: 'saved', challengeId: challenge.id }
}

export async function updateChallenge(
  prisma: PrismaClient,
  id: string,
  input: ChallengeInput
): Promise<SaveChallengeResult> {
  const existing = await prisma.challenge.findUnique({ where: { id } })
  if (!existing) {
    return { kind: 'not_found' }
  }
  if (existing.yamlPath) {
    return { kind: 'file_defined' }
  }

  const validationError = validateChallengeInput(input)
  if (validationError) {
    return { kind: 'validation_error', error: validationError }
  }

  const points = sumPoints(input.checks)
  await prisma.$transaction(async (tx) => {
    await tx.challenge.update({
      where: { id },
      data: {
        title: input.title,
        description: input.description ?? null,
        objective: input.objective ?? null,
        technicalDetails: input.technicalDetails ?? null,
        category: input.category,
        points,
      },
    })
    await tx.challengeCheck.deleteMany({ where: { challengeId: id } })
    await tx.challengeCheck.createMany({ data: checkCreateData(id, input.checks) })
  })

  return { kind: 'saved', challengeId: id }
}

export type SetArchivedResult = { kind: 'updated' } | { kind: 'not_found' }

export async function setChallengeArchived(
  prisma: PrismaClient,
  id: string,
  archived: boolean
): Promise<SetArchivedResult> {
  const existing = await prisma.challenge.findUnique({ where: { id } })
  if (!existing) {
    return { kind: 'not_found' }
  }
  await prisma.challenge.update({ where: { id }, data: { archived } })
  return { kind: 'updated' }
}

export type AdminChallengeListItem = {
  id: string
  title: string
  category: string
  points: number
  archived: boolean
  source: 'file' | 'database'
}

export async function listAdminChallenges(prisma: PrismaClient): Promise<AdminChallengeListItem[]> {
  const challenges = await prisma.challenge.findMany({ orderBy: { createdAt: 'asc' } })
  return challenges.map((c) => ({
    id: c.id,
    title: c.title,
    category: c.category,
    points: c.points,
    archived: c.archived,
    source: c.yamlPath ? 'file' : 'database',
  }))
}

export type AdminChallengeDetail = ChallengeInput & {
  id: string
  archived: boolean
  source: 'file' | 'database'
}

export async function getAdminChallenge(prisma: PrismaClient, id: string): Promise<AdminChallengeDetail | null> {
  const challenge = await prisma.challenge.findUnique({
    where: { id },
    include: { checks: { orderBy: { order: 'asc' } } },
  })
  if (!challenge) return null

  return {
    id: challenge.id,
    title: challenge.title,
    description: challenge.description ?? undefined,
    objective: challenge.objective ?? undefined,
    technicalDetails: challenge.technicalDetails ?? undefined,
    category: challenge.category,
    archived: challenge.archived,
    source: challenge.yamlPath ? 'file' : 'database',
    checks: challenge.checks.map((c) => ({
      name: c.name,
      method: c.method,
      path: c.path,
      requestHeaders: (c.requestHeaders as Record<string, string> | null) ?? undefined,
      requestBody: c.requestBody ?? undefined,
      expectStatus: c.expectStatus,
      expectJson: c.expectJson ?? undefined,
      expectHeaders: (c.expectHeaders as Record<string, string> | null) ?? undefined,
      points: c.points,
    })),
  }
}

export function buildChallengeYaml(
  challenge: { id: string; title: string; category: string },
  checks: {
    name: string
    method: string
    path: string
    requestHeaders: unknown
    requestBody: unknown
    expectStatus: number
    expectJson: unknown
    expectHeaders: unknown
    points: number
  }[]
): string {
  return yaml.dump({
    id: challenge.id,
    title: challenge.title,
    category: challenge.category,
    checks: checks.map((check) => ({
      name: check.name,
      request: {
        method: check.method,
        path: check.path,
        ...(check.requestHeaders != null ? { headers: check.requestHeaders } : {}),
        ...(check.requestBody != null ? { body: check.requestBody } : {}),
      },
      expect: {
        status: check.expectStatus,
        ...(check.expectJson != null ? { json: check.expectJson } : {}),
        ...(check.expectHeaders != null ? { headers: check.expectHeaders } : {}),
      },
      points: check.points,
    })),
  })
}
