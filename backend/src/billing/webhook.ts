import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { constructWebhookEvent } from './stripe'
import { applyWebhookEvent } from './service'

export function createBillingWebhookRouter(prisma: PrismaClient, webhookSecret: string): Router {
  const router = Router()

  router.post('/api/webhooks/stripe', async (req, res) => {
    const signature = req.headers['stripe-signature']

    let event
    try {
      event = constructWebhookEvent(req.body as Buffer, typeof signature === 'string' ? signature : '', webhookSecret)
    } catch {
      res.status(400).json({ error: 'invalid_signature' })
      return
    }

    await applyWebhookEvent(prisma, event)
    res.status(200).json({ received: true })
  })

  return router
}
