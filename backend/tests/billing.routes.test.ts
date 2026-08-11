import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import Stripe from 'stripe'
import { createApp } from '../src/app'

let mockAuthUser = { id: 'billing-routes-test-user', isAdmin: false }

jest.mock('passport', () => {
  const actual = jest.requireActual('passport')
  const originalAuthenticate = actual.authenticate.bind(actual)
  return Object.assign(actual, {
    authenticate: (strategy: string, ...args: any[]) => {
      if (strategy === 'session') {
        return originalAuthenticate(strategy, ...args)
      }
      return (req: any, _res: any, next: any) => {
        req.user = { id: mockAuthUser.id, username: 'octocat', avatarUrl: null, isAdmin: mockAuthUser.isAdmin }
        req.login(req.user, (err: Error) => next(err))
      }
    },
  })
})

const prisma = new PrismaClient()
const USER_ID = 'billing-routes-test-user'
const SETTINGS_ID = 'singleton'

function fakeStripe(overrides: Record<string, unknown> = {}): Stripe {
  return {
    checkout: { sessions: { create: jest.fn() } },
    subscriptions: { update: jest.fn(), retrieve: jest.fn() },
    products: { create: jest.fn() },
    prices: { create: jest.fn() },
    ...overrides,
  } as unknown as Stripe
}

describe('billing/routes', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { isPaid: false, stripeCustomerId: null, stripeSubscriptionId: null },
      create: { id: USER_ID, githubId: 'gh-billing-routes-test', username: 'billing-routes-octocat' },
    })
  })

  afterEach(async () => {
    await prisma.billingSettings.deleteMany({ where: { id: SETTINGS_ID } })
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  beforeEach(() => {
    mockAuthUser = { id: USER_ID, isAdmin: false }
  })

  it('GET /api/billing/status requires auth', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/billing/status')
    expect(res.status).toBe(401)
  })

  it('GET /api/billing/status returns the billing status for the logged-in user', async () => {
    const app = createApp({ prisma, stripeClient: fakeStripe() })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/billing/status')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ isPaid: false, priceCents: null, currency: null, cancelAtPeriodEnd: false })
  })

  it('POST /api/billing/checkout-session returns 503 when billing is not configured', async () => {
    const app = createApp({ prisma, stripeClient: fakeStripe() })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/billing/checkout-session')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'not_configured' })
  })

  it('POST /api/billing/checkout-session returns the checkout url when configured', async () => {
    await prisma.billingSettings.create({
      data: { id: SETTINGS_ID, stripeProductId: 'prod_x', stripePriceId: 'price_x', amountCents: 999, currency: 'usd' },
    })
    const create = jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.test/abc' })
    const app = createApp({ prisma, stripeClient: fakeStripe({ checkout: { sessions: { create } } }) })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/billing/checkout-session')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ url: 'https://checkout.stripe.test/abc' })
  })

  it('POST /api/billing/checkout-session returns 409 for an already-paid user', async () => {
    await prisma.billingSettings.create({
      data: { id: SETTINGS_ID, stripeProductId: 'prod_x', stripePriceId: 'price_x', amountCents: 999, currency: 'usd' },
    })
    await prisma.user.update({ where: { id: USER_ID }, data: { isPaid: true, stripeSubscriptionId: 'sub_x' } })
    const app = createApp({ prisma, stripeClient: fakeStripe() })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/billing/checkout-session')
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'already_paid' })

    await prisma.user.update({ where: { id: USER_ID }, data: { isPaid: false, stripeSubscriptionId: null } })
  })

  it('POST /api/billing/cancel returns 409 for a user with no subscription', async () => {
    const app = createApp({ prisma, stripeClient: fakeStripe() })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/billing/cancel')
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'no_subscription' })
  })

  it('POST /api/billing/cancel returns 200 for a paid user', async () => {
    await prisma.user.update({ where: { id: USER_ID }, data: { isPaid: true, stripeSubscriptionId: 'sub_x' } })
    const update = jest.fn().mockResolvedValue({})
    const app = createApp({ prisma, stripeClient: fakeStripe({ subscriptions: { update, retrieve: jest.fn() } }) })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.post('/api/billing/cancel')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ canceled: true })

    await prisma.user.update({ where: { id: USER_ID }, data: { isPaid: false, stripeSubscriptionId: null } })
  })
})
