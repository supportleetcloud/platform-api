import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { requireAuth } from '../auth/middleware'
import { requireAdmin } from './middleware'
import { getLlmSettings, saveLlmSettings } from '../llm/settings'

export function createAdminRouter(prisma: PrismaClient): Router {
  const router = Router()

  router.get('/api/admin/llm-settings', requireAuth, requireAdmin, async (_req, res) => {
    const settings = await getLlmSettings(prisma)
    res.json(settings)
  })

  router.put('/api/admin/llm-settings', requireAuth, requireAdmin, async (req, res) => {
    try {
      const body = req.body ?? {}
      const result = await saveLlmSettings(prisma, {
        provider: body.provider,
        model: body.model,
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
      })

      if (result.kind === 'validation_error') {
        res.status(400).json({ error: result.error })
        return
      }

      const settings = await getLlmSettings(prisma)
      res.json(settings)
    } catch (err) {
      console.error('Failed to save LLM settings:', err)
      res.status(500).json({ error: 'failed to save settings' })
    }
  })

  return router
}
