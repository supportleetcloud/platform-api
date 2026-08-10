import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { requireAuth } from '../auth/middleware'
import { getCurrentVersion, acceptCurrentVersion } from './service'

export function createTosRouter(prisma: PrismaClient): Router {
  const router = Router()

  router.get('/api/tos/current', requireAuth, async (_req, res) => {
    const current = await getCurrentVersion(prisma)
    if (!current) {
      res.status(404).json({ error: 'tos_not_configured' })
      return
    }
    res.json({ id: current.id, content: current.content, publishedAt: current.publishedAt })
  })

  router.post('/api/tos/accept', requireAuth, async (req, res) => {
    const user = req.user as { id: string }
    const tosVersionId = req.body?.tosVersionId

    if (typeof tosVersionId !== 'string' || tosVersionId.length === 0) {
      res.status(400).json({ error: 'tosVersionId is required' })
      return
    }

    const result = await acceptCurrentVersion(prisma, user.id, tosVersionId)
    if (result.kind === 'stale_version') {
      res.status(409).json({ error: 'stale_version' })
      return
    }
    if (result.kind === 'not_configured') {
      res.status(404).json({ error: 'tos_not_configured' })
      return
    }
    res.status(200).json({ ok: true })
  })

  return router
}
