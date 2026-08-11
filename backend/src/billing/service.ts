import { PrismaClient } from '@prisma/client'
import Stripe from 'stripe'
import {
  createCheckoutSession,
  cancelSubscription,
  getSubscriptionStatus,
  createProduct,
  createPrice,
  WebhookEvent,
} from './stripe'

const SETTINGS_ID = 'singleton'

export type BillingStatus = {
  isPaid: boolean
  priceCents: number | null
  currency: string | null
  cancelAtPeriodEnd: boolean
}

export async function getBillingStatus(prisma: PrismaClient, stripe: Stripe, userId: string): Promise<BillingStatus> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  const settings = await prisma.billingSettings.findUnique({ where: { id: SETTINGS_ID } })

  let cancelAtPeriodEnd = false
  if (user.isPaid && user.stripeSubscriptionId) {
    const status = await getSubscriptionStatus(stripe, user.stripeSubscriptionId)
    cancelAtPeriodEnd = status.cancelAtPeriodEnd
  }

  return {
    isPaid: user.isPaid,
    priceCents: settings?.amountCents ?? null,
    currency: settings?.currency ?? null,
    cancelAtPeriodEnd,
  }
}

export type StartCheckoutResult =
  | { kind: 'created'; url: string }
  | { kind: 'already_paid' }
  | { kind: 'not_configured' }

export async function startCheckout(
  prisma: PrismaClient,
  stripe: Stripe,
  userId: string,
  frontendUrl: string
): Promise<StartCheckoutResult> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  if (user.isPaid) {
    return { kind: 'already_paid' }
  }

  const settings = await prisma.billingSettings.findUnique({ where: { id: SETTINGS_ID } })
  if (!settings) {
    return { kind: 'not_configured' }
  }

  const { url } = await createCheckoutSession(stripe, {
    userId,
    customerId: user.stripeCustomerId,
    priceId: settings.stripePriceId,
    successUrl: `${frontendUrl}/dashboard?checkout=success`,
    cancelUrl: `${frontendUrl}/dashboard?checkout=cancelled`,
  })
  return { kind: 'created', url }
}

export type CancelResult = { kind: 'canceled' } | { kind: 'no_subscription' }

export async function requestCancellation(prisma: PrismaClient, stripe: Stripe, userId: string): Promise<CancelResult> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  if (!user.isPaid || !user.stripeSubscriptionId) {
    return { kind: 'no_subscription' }
  }

  await cancelSubscription(stripe, user.stripeSubscriptionId)
  return { kind: 'canceled' }
}

export async function applyWebhookEvent(prisma: PrismaClient, event: WebhookEvent): Promise<void> {
  if (event.kind === 'checkout_completed') {
    await prisma.user.update({
      where: { id: event.userId },
      data: { stripeCustomerId: event.customerId, stripeSubscriptionId: event.subscriptionId, isPaid: true },
    })
    return
  }

  if (event.kind === 'subscription_deleted') {
    const user = await prisma.user.findFirst({ where: { stripeCustomerId: event.customerId } })
    if (!user) return
    await prisma.user.update({
      where: { id: user.id },
      data: { isPaid: false, stripeSubscriptionId: null },
    })
    return
  }

  // 'ignored' — no-op
}

export async function getAdminBillingSettings(prisma: PrismaClient): Promise<{ priceCents: number; currency: string } | null> {
  const settings = await prisma.billingSettings.findUnique({ where: { id: SETTINGS_ID } })
  if (!settings) return null
  return { priceCents: settings.amountCents, currency: settings.currency }
}

export type UpdatePriceResult =
  | { kind: 'updated'; priceCents: number; currency: string }
  | { kind: 'validation_error'; error: string }

export async function updatePrice(prisma: PrismaClient, stripe: Stripe, amountCents: number): Promise<UpdatePriceResult> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { kind: 'validation_error', error: 'amountCents must be a positive integer' }
  }

  const existing = await prisma.billingSettings.findUnique({ where: { id: SETTINGS_ID } })
  const currency = existing?.currency ?? 'usd'
  const stripeProductId = existing?.stripeProductId ?? (await createProduct(stripe, 'LetCode Pro'))
  const stripePriceId = await createPrice(stripe, stripeProductId, amountCents, currency)

  await prisma.billingSettings.upsert({
    where: { id: SETTINGS_ID },
    update: { stripeProductId, stripePriceId, amountCents, currency },
    create: { id: SETTINGS_ID, stripeProductId, stripePriceId, amountCents, currency },
  })

  return { kind: 'updated', priceCents: amountCents, currency }
}
