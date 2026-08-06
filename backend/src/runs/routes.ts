import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { requireAuth } from '../auth/middleware'
import { submitRun, getRun, RunsServiceConfig } from './service'

export type RunsRouterConfig = RunsServiceConfig

export function createRunsRouter(
  prisma: PrismaClient,
  fetchImpl: typeof fetch,
  config: RunsRouterConfig
): Router {
  const router = Router()

  router.post('/api/runs', requireAuth, async (req, res) => {
    const user = req.user as { id: string }
    const body = req.body ?? {}

    const result = await submitRun(prisma, fetchImpl, config, {
      userId: user.id,
      challengeId: body.challengeId,
      targetUrl: body.targetUrl,
      confirmedAuthorization: body.confirmedAuthorization === true,
    })

    if (result.kind === 'accepted') {
      res.status(202).json({ runId: result.runId, status: 'pending' })
      return
    }
    if (result.kind === 'validation_error') {
      res.status(400).json({ error: result.error })
      return
    }
    if (result.kind === 'free_tier_limit') {
      res.status(403).json({ error: result.error })
      return
    }
    if (result.kind === 'internal_error') {
      res.status(500).json({ error: result.error })
      return
    }
    res.status(502).json({ error: result.error })
  })

  router.get('/api/runs/:id', requireAuth, async (req, res) => {
    const user = req.user as { id: string }
    const result = await getRun(prisma, config.runTimeoutMs, { runId: req.params.id, userId: user.id })

    if (result.kind === 'not_found') {
      res.status(404).json({ error: 'run_not_found' })
      return
    }

    res.status(200).json(result.run)
  })

  return router
}
