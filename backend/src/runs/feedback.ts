import { PrismaClient } from '@prisma/client'
import { getLlmSettingsForGeneration } from '../llm/settings'
import { generateFeedback, FeedbackCheck } from '../llm/providers'

export async function generateFeedbackForRun(
  prisma: PrismaClient,
  fetchImpl: typeof fetch,
  runId: string
): Promise<void> {
  try {
    const run = await prisma.run.findUnique({ where: { id: runId }, include: { challenge: true } })
    if (!run) {
      return
    }

    const settingsResult = await getLlmSettingsForGeneration(prisma)
    if (settingsResult.kind === 'not_configured') {
      await prisma.run.update({ where: { id: runId }, data: { feedbackStatus: 'failed' } })
      return
    }

    const checks: FeedbackCheck[] = Array.isArray(run.checks) ? (run.checks as unknown as FeedbackCheck[]) : []

    const feedback = await generateFeedback(fetchImpl, settingsResult.config, {
      challengeTitle: run.challenge.title,
      score: run.score ?? 0,
      checks,
    })

    await prisma.run.update({ where: { id: runId }, data: { feedback, feedbackStatus: 'ready' } })
  } catch (err) {
    console.error(`Feedback generation failed for run ${runId}:`, err)
    await prisma.run.update({ where: { id: runId }, data: { feedbackStatus: 'failed' } }).catch(() => {})
  }
}
