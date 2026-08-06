import { PrismaClient } from '@prisma/client'
import { randomUUID, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { CHALLENGES_DIR } from '../challenges/service'

const FREE_TIER_CHALLENGE_LIMIT = 2
const FREE_TIER_ATTEMPT_LIMIT = 10

export type RunsServiceConfig = {
  validationEngineUrl: string
  webhookBaseUrl: string
  runTimeoutMs: number
}

export type SubmitRunInput = {
  userId: string
  challengeId: string
  targetUrl: string
  confirmedAuthorization: boolean
}

export type SubmitRunResult =
  | { kind: 'accepted'; runId: string }
  | { kind: 'validation_error'; error: string }
  | { kind: 'free_tier_limit'; error: string }
  | { kind: 'engine_unreachable'; runId: string; error: string }
  | { kind: 'internal_error'; error: string }

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

async function freeTierLimitError(
  prisma: PrismaClient,
  userId: string,
  challengeId: string
): Promise<string | null> {
  const attempted = await prisma.run.findMany({
    where: { userId },
    distinct: ['challengeId'],
    select: { challengeId: true },
  })
  const attemptedIds = attempted.map((run) => run.challengeId)

  if (!attemptedIds.includes(challengeId) && attemptedIds.length >= FREE_TIER_CHALLENGE_LIMIT) {
    return `free tier is limited to ${FREE_TIER_CHALLENGE_LIMIT} challenges`
  }

  const attemptCount = await prisma.run.count({ where: { userId, challengeId } })
  if (attemptCount >= FREE_TIER_ATTEMPT_LIMIT) {
    return `free tier is limited to ${FREE_TIER_ATTEMPT_LIMIT} attempts per challenge`
  }

  return null
}

export async function submitRun(
  prisma: PrismaClient,
  fetchImpl: typeof fetch,
  config: RunsServiceConfig,
  input: SubmitRunInput
): Promise<SubmitRunResult> {
  if (input.confirmedAuthorization !== true) {
    return { kind: 'validation_error', error: 'confirmedAuthorization must be true' }
  }
  if (!isHttpUrl(input.targetUrl)) {
    return { kind: 'validation_error', error: 'targetUrl must be a valid http(s) URL' }
  }
  if (typeof input.challengeId !== 'string' || input.challengeId.length === 0) {
    return { kind: 'validation_error', error: 'challengeId is required' }
  }

  const challenge = await prisma.challenge.findUnique({ where: { id: input.challengeId } })
  if (!challenge) {
    return { kind: 'validation_error', error: 'challenge not found' }
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId } })
  if (!user.isPaid) {
    const gateError = await freeTierLimitError(prisma, input.userId, input.challengeId)
    if (gateError) {
      return { kind: 'free_tier_limit', error: gateError }
    }
  }

  let challengeYaml: string
  try {
    challengeYaml = fs.readFileSync(path.join(CHALLENGES_DIR, challenge.yamlPath), 'utf-8')
  } catch (err) {
    console.error(`Failed to read challenge YAML for ${challenge.id} at ${challenge.yamlPath}:`, err)
    return { kind: 'internal_error', error: 'failed to load challenge definition' }
  }

  const jobId = randomUUID()
  const callbackToken = randomBytes(24).toString('hex')

  await prisma.run.create({
    data: {
      id: jobId,
      userId: input.userId,
      challengeId: input.challengeId,
      targetUrl: input.targetUrl,
      status: 'pending',
      callbackToken,
    },
  })

  const webhookUrl = `${config.webhookBaseUrl}/api/webhooks/runs/${jobId}?token=${callbackToken}`

  try {
    const response = await fetchImpl(`${config.validationEngineUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, targetUrl: input.targetUrl, challengeYaml, webhookUrl }),
    })
    if (!response.ok) {
      throw new Error(`validation engine responded ${response.status}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    await prisma.run.update({
      where: { id: jobId },
      data: { status: 'error', error: 'failed to reach validation engine' },
    })
    return { kind: 'engine_unreachable', runId: jobId, error: message }
  }

  return { kind: 'accepted', runId: jobId }
}

export type GetRunInput = { runId: string; userId: string }

export type GetRunResult =
  | { kind: 'not_found' }
  | {
      kind: 'found'
      run: {
        runId: string
        challengeId: string
        targetUrl: string
        status: string
        score: number | null
        checks: unknown
        error: string | null
        createdAt: Date
      }
    }

export async function getRun(
  prisma: PrismaClient,
  runTimeoutMs: number,
  input: GetRunInput
): Promise<GetRunResult> {
  const run = await prisma.run.findUnique({ where: { id: input.runId } })
  if (!run || run.userId !== input.userId) {
    return { kind: 'not_found' }
  }

  const isStale = run.status === 'pending' && Date.now() - run.createdAt.getTime() > runTimeoutMs
  const status = isStale ? 'timed_out' : run.status

  return {
    kind: 'found',
    run: {
      runId: run.id,
      challengeId: run.challengeId,
      targetUrl: run.targetUrl,
      status,
      score: run.score,
      checks: run.checks,
      error: run.error,
      createdAt: run.createdAt,
    },
  }
}
