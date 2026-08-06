import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { timingSafeEqual } from 'crypto'

function tokensMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected)
  const providedBuf = Buffer.from(provided)
  if (expectedBuf.length !== providedBuf.length) {
    return false
  }
  return timingSafeEqual(expectedBuf, providedBuf)
}

export function createRunsWebhookRouter(prisma: PrismaClient): Router {
  const router = Router()

  router.post('/api/webhooks/runs/:jobId', async (req, res) => {
    const run = await prisma.run.findUnique({ where: { id: req.params.jobId } })
    if (!run) {
      res.status(404).json({ error: 'run_not_found' })
      return
    }

    const token = typeof req.query.token === 'string' ? req.query.token : ''
    if (!tokensMatch(run.callbackToken, token)) {
      res.status(403).json({ error: 'invalid_token' })
      return
    }

    if (run.status !== 'pending') {
      res.status(200).json({ status: 'already_processed' })
      return
    }

    const body = req.body ?? {}
    if (body.status !== 'completed' && body.status !== 'error') {
      res.status(400).json({ error: 'invalid_status' })
      return
    }

    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: body.status,
        score: body.score ?? null,
        error: body.error ?? null,
        // The engine's RunResult omits `checks` entirely on an error status (rather than
        // sending it as JSON null) — only spread it in when present, so we never pass a bare
        // `null` for this Json? column (Prisma treats that ambiguously; explicit omission
        // avoids the question entirely).
        ...(body.checks !== undefined ? { checks: body.checks } : {}),
      },
    })

    res.status(200).json({ status: 'ok' })
  })

  return router
}
