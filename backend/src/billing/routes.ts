import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import Stripe from 'stripe'
import { requireAuth } from '../auth/middleware'
import { getBillingStatus, startCheckout, requestCancellation } from './service'

export type BillingRouterConfig = { frontendUrl: string }

export function createBillingRouter(prisma: PrismaClient, stripe: Stripe, config: BillingRouterConfig): Router {
  const router = Router()

  router.get('/api/billing/status', requireAuth, async (req, res) => {
    const user = req.user as { id: string }
    const status = await getBillingStatus(prisma, stripe, user.id)
    res.status(200).json(status)
  })

  router.post('/api/billing/checkout-session', requireAuth, async (req, res) => {
    const user = req.user as { id: string }
    const result = await startCheckout(prisma, stripe, user.id, config.frontendUrl)

    if (result.kind === 'created') {
      res.status(200).json({ url: result.url })
      return
    }
    if (result.kind === 'already_paid') {
      res.status(409).json({ error: 'already_paid' })
      return
    }
    res.status(503).json({ error: 'not_configured' })
  })

  router.post('/api/billing/cancel', requireAuth, async (req, res) => {
    const user = req.user as { id: string }
    const result = await requestCancellation(prisma, stripe, user.id)

    if (result.kind === 'canceled') {
      res.status(200).json({ canceled: true })
      return
    }
    res.status(409).json({ error: 'no_subscription' })
  })

  return router
}
