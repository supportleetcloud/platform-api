import request from 'supertest'
import Stripe from 'stripe'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'

const prisma = new PrismaClient()
const USER_ID = 'billing-webhook-test-user'
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET as string

function sign(payload: string) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
}

describe('POST /api/webhooks/stripe', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { isPaid: false, stripeCustomerId: null, stripeSubscriptionId: null },
      create: { id: USER_ID, githubId: 'gh-billing-webhook-test', username: 'billing-webhook-octocat' },
    })
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  it('returns 400 for a missing/invalid signature', async () => {
    const app = createApp({ prisma })
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'not-a-real-signature')
      .send(JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } }))
    expect(res.status).toBe(400)
  })

  it('applies a checkout.session.completed event and flips isPaid', async () => {
    const app = createApp({ prisma })
    const payload = JSON.stringify({
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: USER_ID,
          customer: 'cus_webhook_test',
          subscription: 'sub_webhook_test',
        },
      },
    })

    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', sign(payload))
      .send(payload)

    expect(res.status).toBe(200)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: USER_ID } })
    expect(user.isPaid).toBe(true)
    expect(user.stripeCustomerId).toBe('cus_webhook_test')
    expect(user.stripeSubscriptionId).toBe('sub_webhook_test')
  })

  it('applies a customer.subscription.deleted event and flips isPaid back off', async () => {
    const app = createApp({ prisma })
    const payload = JSON.stringify({
      id: 'evt_test_2',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_webhook_test' } },
    })

    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', sign(payload))
      .send(payload)

    expect(res.status).toBe(200)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: USER_ID } })
    expect(user.isPaid).toBe(false)
    expect(user.stripeSubscriptionId).toBeNull()
  })

  it('returns 200 for an event type it does not act on', async () => {
    const app = createApp({ prisma })
    const payload = JSON.stringify({ id: 'evt_test_3', type: 'invoice.payment_failed', data: { object: {} } })

    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', sign(payload))
      .send(payload)

    expect(res.status).toBe(200)
  })
})
