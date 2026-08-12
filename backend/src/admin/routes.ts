import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import Stripe from 'stripe'
import { requireAuth } from '../auth/middleware'
import { requireAdmin } from './middleware'
import { getLlmSettings, saveLlmSettings } from '../llm/settings'
import { listOllamaModels } from '../llm/ollama'
import { listVersions, publishVersion } from '../tos/service'
import { getAdminBillingSettings, updatePrice } from '../billing/service'

export function createAdminRouter(prisma: PrismaClient, stripe: Stripe, fetchImpl: typeof fetch): Router {
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

  router.get('/api/admin/llm-settings/ollama-models', requireAuth, requireAdmin, async (req, res) => {
    const baseUrl = typeof req.query.baseUrl === 'string' ? req.query.baseUrl.trim() : ''
    if (baseUrl.length === 0) {
      res.status(400).json({ error: 'baseUrl is required' })
      return
    }

    try {
      const models = await listOllamaModels(fetchImpl, baseUrl)
      res.json({ models })
    } catch (err) {
      console.error('Failed to list Ollama models:', err)
      res.status(502).json({ error: 'could not reach ollama' })
    }
  })

  router.get('/api/admin/tos/versions', requireAuth, requireAdmin, async (_req, res) => {
    const versions = await listVersions(prisma)
    res.json(versions.map((v) => ({ id: v.id, content: v.content, publishedAt: v.publishedAt })))
  })

  router.post('/api/admin/tos/versions', requireAuth, requireAdmin, async (req, res) => {
    const result = await publishVersion(prisma, req.body?.content)
    if (result.kind === 'validation_error') {
      res.status(400).json({ error: result.error })
      return
    }
    res.status(201).json({
      id: result.version.id,
      content: result.version.content,
      publishedAt: result.version.publishedAt,
    })
  })

  router.get('/api/admin/billing-settings', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const settings = await getAdminBillingSettings(prisma)
      res.json(settings)
    } catch (err) {
      console.error('Failed to load billing settings:', err)
      res.status(500).json({ error: 'failed to load billing settings' })
    }
  })

  router.put('/api/admin/billing-settings', requireAuth, requireAdmin, async (req, res) => {
    try {
      const amountCents = req.body?.amountCents
      const result = await updatePrice(prisma, stripe, amountCents)

      if (result.kind === 'validation_error') {
        res.status(400).json({ error: result.error })
        return
      }
      res.json({ priceCents: result.priceCents, currency: result.currency })
    } catch (err) {
      console.error('Failed to update billing settings:', err)
      res.status(500).json({ error: 'failed to update billing settings' })
    }
  })

  return router
}
