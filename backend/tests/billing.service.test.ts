import { PrismaClient } from '@prisma/client'
import Stripe from 'stripe'
import {
  getBillingStatus,
  startCheckout,
  requestCancellation,
  applyWebhookEvent,
  getAdminBillingSettings,
  updatePrice,
} from '../src/billing/service'

const prisma = new PrismaClient()
const SETTINGS_ID = 'singleton'

const USER_FREE = 'billing-service-test-free'
const USER_PAID = 'billing-service-test-paid'
const USER_FREE_WITH_CUSTOMER = 'billing-service-test-free-with-customer'

function fakeStripe(overrides: Record<string, unknown> = {}): Stripe {
  return {
    checkout: { sessions: { create: jest.fn() } },
    subscriptions: { update: jest.fn(), retrieve: jest.fn() },
    products: { create: jest.fn() },
    prices: { create: jest.fn() },
    ...overrides,
  } as unknown as Stripe
}

describe('billing/service', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_FREE },
      update: { isPaid: false, stripeCustomerId: null, stripeSubscriptionId: null },
      create: { id: USER_FREE, githubId: 'gh-billing-free', username: 'free-billing-test' },
    })
    await prisma.user.upsert({
      where: { id: USER_PAID },
      update: {
        isPaid: true,
        stripeCustomerId: 'cus_test_paid',
        stripeSubscriptionId: 'sub_test_paid',
      },
      create: {
        id: USER_PAID,
        githubId: 'gh-billing-paid',
        username: 'paid-billing-test',
        isPaid: true,
        stripeCustomerId: 'cus_test_paid',
        stripeSubscriptionId: 'sub_test_paid',
      },
    })
    await prisma.user.upsert({
      where: { id: USER_FREE_WITH_CUSTOMER },
      update: { isPaid: false, stripeCustomerId: 'cus_test_free_returning', stripeSubscriptionId: null },
      create: {
        id: USER_FREE_WITH_CUSTOMER,
        githubId: 'gh-billing-free-returning',
        username: 'free-returning-billing-test',
        isPaid: false,
        stripeCustomerId: 'cus_test_free_returning',
      },
    })
  })

  afterEach(async () => {
    await prisma.billingSettings.deleteMany({ where: { id: SETTINGS_ID } })
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: USER_FREE } }).catch(() => {})
    await prisma.user.delete({ where: { id: USER_PAID } }).catch(() => {})
    await prisma.user.delete({ where: { id: USER_FREE_WITH_CUSTOMER } }).catch(() => {})
    await prisma.$disconnect()
  })

  describe('getBillingStatus', () => {
    it('returns isPaid false and null price with no BillingSettings row', async () => {
      const status = await getBillingStatus(prisma, fakeStripe(), USER_FREE)
      expect(status).toEqual({ isPaid: false, priceCents: null, currency: null, cancelAtPeriodEnd: false })
    })

    it('returns the configured price for a free user', async () => {
      await prisma.billingSettings.create({
        data: { id: SETTINGS_ID, stripeProductId: 'prod_x', stripePriceId: 'price_x', amountCents: 999, currency: 'usd' },
      })
      const status = await getBillingStatus(prisma, fakeStripe(), USER_FREE)
      expect(status).toEqual({ isPaid: false, priceCents: 999, currency: 'usd', cancelAtPeriodEnd: false })
    })

    it('fetches live cancelAtPeriodEnd for a paid user with a subscription', async () => {
      const retrieve = jest.fn().mockResolvedValue({ status: 'active', cancel_at_period_end: true })
      const status = await getBillingStatus(prisma, fakeStripe({ subscriptions: { update: jest.fn(), retrieve } }), USER_PAID)
      expect(retrieve).toHaveBeenCalledWith('sub_test_paid')
      expect(status.isPaid).toBe(true)
      expect(status.cancelAtPeriodEnd).toBe(true)
    })

    it('degrades cancelAtPeriodEnd to false, without failing the whole response, when the live Stripe call fails', async () => {
      const retrieve = jest.fn().mockRejectedValue(new Error('Stripe API unavailable'))
      const status = await getBillingStatus(prisma, fakeStripe({ subscriptions: { update: jest.fn(), retrieve } }), USER_PAID)
      expect(status.isPaid).toBe(true)
      expect(status.cancelAtPeriodEnd).toBe(false)
    })
  })

  describe('startCheckout', () => {
    it('returns not_configured with no BillingSettings row', async () => {
      const result = await startCheckout(prisma, fakeStripe(), USER_FREE, 'http://localhost:3000')
      expect(result).toEqual({ kind: 'not_configured' })
    })

    it('returns already_paid for a user who is already paid', async () => {
      await prisma.billingSettings.create({
        data: { id: SETTINGS_ID, stripeProductId: 'prod_x', stripePriceId: 'price_x', amountCents: 999, currency: 'usd' },
      })
      const result = await startCheckout(prisma, fakeStripe(), USER_PAID, 'http://localhost:3000')
      expect(result).toEqual({ kind: 'already_paid' })
    })

    it('creates a checkout session and returns its url, reusing an existing stripeCustomerId', async () => {
      await prisma.billingSettings.create({
        data: { id: SETTINGS_ID, stripeProductId: 'prod_x', stripePriceId: 'price_x', amountCents: 999, currency: 'usd' },
      })
      const create = jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.test/session-1' })
      const stripe = fakeStripe({ checkout: { sessions: { create } } })

      const result = await startCheckout(prisma, stripe, USER_FREE_WITH_CUSTOMER, 'http://localhost:3000')

      expect(result).toEqual({ kind: 'created', url: 'https://checkout.stripe.test/session-1' })
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_test_free_returning', client_reference_id: USER_FREE_WITH_CUSTOMER })
      )
    })

    it('creates a checkout session for a free user with no stripeCustomerId yet', async () => {
      await prisma.billingSettings.create({
        data: { id: SETTINGS_ID, stripeProductId: 'prod_x', stripePriceId: 'price_x', amountCents: 999, currency: 'usd' },
      })
      const create = jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.test/session-2' })
      const stripe = fakeStripe({ checkout: { sessions: { create } } })

      const result = await startCheckout(prisma, stripe, USER_FREE, 'http://localhost:3000')

      expect(result).toEqual({ kind: 'created', url: 'https://checkout.stripe.test/session-2' })
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          client_reference_id: USER_FREE,
          customer: undefined,
          success_url: 'http://localhost:3000/dashboard?checkout=success',
          cancel_url: 'http://localhost:3000/dashboard?checkout=cancelled',
        })
      )
    })
  })

  describe('requestCancellation', () => {
    it('returns no_subscription for a free user', async () => {
      const result = await requestCancellation(prisma, fakeStripe(), USER_FREE)
      expect(result).toEqual({ kind: 'no_subscription' })
    })

    it('calls cancelSubscription for a paid user and returns canceled', async () => {
      const update = jest.fn().mockResolvedValue({})
      const stripe = fakeStripe({ subscriptions: { update, retrieve: jest.fn() } })

      const result = await requestCancellation(prisma, stripe, USER_PAID)

      expect(result).toEqual({ kind: 'canceled' })
      expect(update).toHaveBeenCalledWith('sub_test_paid', { cancel_at_period_end: true })
    })
  })

  describe('applyWebhookEvent', () => {
    it('sets isPaid true and stores customer/subscription ids on checkout_completed', async () => {
      await applyWebhookEvent(prisma, {
        kind: 'checkout_completed',
        userId: USER_FREE,
        customerId: 'cus_new',
        subscriptionId: 'sub_new',
      })

      const user = await prisma.user.findUniqueOrThrow({ where: { id: USER_FREE } })
      expect(user.isPaid).toBe(true)
      expect(user.stripeCustomerId).toBe('cus_new')
      expect(user.stripeSubscriptionId).toBe('sub_new')

      // idempotent on a duplicate delivery
      await applyWebhookEvent(prisma, {
        kind: 'checkout_completed',
        userId: USER_FREE,
        customerId: 'cus_new',
        subscriptionId: 'sub_new',
      })
      const again = await prisma.user.findUniqueOrThrow({ where: { id: USER_FREE } })
      expect(again.isPaid).toBe(true)
    })

    it('sets isPaid false and clears stripeSubscriptionId on subscription_deleted, found by customerId', async () => {
      await applyWebhookEvent(prisma, {
        kind: 'subscription_deleted',
        customerId: 'cus_test_paid',
        subscriptionId: 'sub_test_paid',
      })

      const user = await prisma.user.findUniqueOrThrow({ where: { id: USER_PAID } })
      expect(user.isPaid).toBe(false)
      expect(user.stripeSubscriptionId).toBeNull()
      // stripeCustomerId is kept for a future resubscribe
      expect(user.stripeCustomerId).toBe('cus_test_paid')

      await prisma.user.update({
        where: { id: USER_PAID },
        data: { isPaid: true, stripeSubscriptionId: 'sub_test_paid' },
      })
    })

    it('is a no-op for a stale subscription_deleted event whose subscriptionId no longer matches the user (resubscribed)', async () => {
      // Simulates a cancel-then-resubscribe: the user's CURRENT subscription is 'sub_new',
      // but a `deleted` event for the OLD subscription 'sub_old' arrives late/out-of-order
      // (same stripeCustomerId, since that id is stable across resubscribes).
      await prisma.user.update({
        where: { id: USER_PAID },
        data: { isPaid: true, stripeCustomerId: 'cus_test_paid', stripeSubscriptionId: 'sub_new' },
      })

      await applyWebhookEvent(prisma, {
        kind: 'subscription_deleted',
        customerId: 'cus_test_paid',
        subscriptionId: 'sub_old',
      })

      const user = await prisma.user.findUniqueOrThrow({ where: { id: USER_PAID } })
      expect(user.isPaid).toBe(true)
      expect(user.stripeSubscriptionId).toBe('sub_new')

      await prisma.user.update({
        where: { id: USER_PAID },
        data: { isPaid: true, stripeCustomerId: 'cus_test_paid', stripeSubscriptionId: 'sub_test_paid' },
      })
    })

    it('is a no-op for ignored events', async () => {
      await expect(applyWebhookEvent(prisma, { kind: 'ignored' })).resolves.toBeUndefined()
    })

    it('does not throw on checkout_completed for a user id that no longer exists (C1 repro)', async () => {
      // Reproduces the crash the reviewer found: a validly-signed checkout.session.completed
      // webhook for a deleted/nonexistent user used to hit prisma.user.update() unconditionally,
      // which throws on a missing row — uncaught, since Express 4 doesn't catch async
      // rejections. Stripe retries for up to 3 days, so this used to be a crash loop.
      await expect(
        applyWebhookEvent(prisma, {
          kind: 'checkout_completed',
          userId: 'billing-service-test-does-not-exist',
          customerId: 'cus_ghost',
          subscriptionId: 'sub_ghost',
        })
      ).resolves.toBeUndefined()
    })
  })

  describe('getAdminBillingSettings', () => {
    it('returns null with no row', async () => {
      expect(await getAdminBillingSettings(prisma)).toBeNull()
    })

    it('returns priceCents/currency with a row', async () => {
      await prisma.billingSettings.create({
        data: { id: SETTINGS_ID, stripeProductId: 'prod_x', stripePriceId: 'price_x', amountCents: 1999, currency: 'usd' },
      })
      expect(await getAdminBillingSettings(prisma)).toEqual({ priceCents: 1999, currency: 'usd' })
    })
  })

  describe('updatePrice', () => {
    it('rejects zero, negative, and non-integer amountCents', async () => {
      const stripe = fakeStripe()
      expect(await updatePrice(prisma, stripe, 0)).toEqual({
        kind: 'validation_error',
        error: 'amountCents must be a positive integer',
      })
      expect(await updatePrice(prisma, stripe, -100)).toEqual({
        kind: 'validation_error',
        error: 'amountCents must be a positive integer',
      })
      expect(await updatePrice(prisma, stripe, 9.5)).toEqual({
        kind: 'validation_error',
        error: 'amountCents must be a positive integer',
      })
    })

    it('bootstraps a Product + Price when no BillingSettings row exists yet', async () => {
      const createProductMock = jest.fn().mockResolvedValue({ id: 'prod_new' })
      const createPriceMock = jest.fn().mockResolvedValue({ id: 'price_new' })
      const stripe = fakeStripe({
        products: { create: createProductMock },
        prices: { create: createPriceMock },
      })

      const result = await updatePrice(prisma, stripe, 999)

      expect(result).toEqual({ kind: 'updated', priceCents: 999, currency: 'usd' })
      expect(createProductMock).toHaveBeenCalledTimes(1)
      const settings = await prisma.billingSettings.findUniqueOrThrow({ where: { id: SETTINGS_ID } })
      expect(settings.stripeProductId).toBe('prod_new')
      expect(settings.stripePriceId).toBe('price_new')
    })

    it('reuses the existing stripeProductId on a subsequent price change', async () => {
      await prisma.billingSettings.create({
        data: { id: SETTINGS_ID, stripeProductId: 'prod_existing', stripePriceId: 'price_old', amountCents: 999, currency: 'usd' },
      })
      const createProductMock = jest.fn()
      const createPriceMock = jest.fn().mockResolvedValue({ id: 'price_new_2' })
      const stripe = fakeStripe({
        products: { create: createProductMock },
        prices: { create: createPriceMock },
      })

      const result = await updatePrice(prisma, stripe, 1999)

      expect(result).toEqual({ kind: 'updated', priceCents: 1999, currency: 'usd' })
      expect(createProductMock).not.toHaveBeenCalled()
      expect(createPriceMock).toHaveBeenCalledWith({
        product: 'prod_existing',
        unit_amount: 1999,
        currency: 'usd',
        recurring: { interval: 'month' },
      })
      const settings = await prisma.billingSettings.findUniqueOrThrow({ where: { id: SETTINGS_ID } })
      expect(settings.stripePriceId).toBe('price_new_2')
      expect(settings.stripeProductId).toBe('prod_existing')
    })
  })
})
