import Stripe from 'stripe'

export type WebhookEvent =
  | { kind: 'checkout_completed'; userId: string; customerId: string; subscriptionId: string }
  | { kind: 'subscription_deleted'; customerId: string }
  | { kind: 'ignored' }

export async function createCheckoutSession(
  stripe: Stripe,
  input: {
    userId: string
    customerId: string | null
    priceId: string
    successUrl: string
    cancelUrl: string
  }
): Promise<{ url: string }> {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: input.priceId, quantity: 1 }],
    client_reference_id: input.userId,
    customer: input.customerId ?? undefined,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  })
  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL')
  }
  return { url: session.url }
}

// Pure local signature verification — no Stripe API call, no client instance needed.
export function constructWebhookEvent(rawBody: Buffer, signature: string, webhookSecret: string): WebhookEvent {
  const event = Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session
    const userId = session.client_reference_id
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id
    const subscriptionId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription?.id
    if (!userId || !customerId || !subscriptionId) {
      return { kind: 'ignored' }
    }
    return { kind: 'checkout_completed', userId, customerId, subscriptionId }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object as Stripe.Subscription
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
    return { kind: 'subscription_deleted', customerId }
  }

  return { kind: 'ignored' }
}

export async function cancelSubscription(stripe: Stripe, subscriptionId: string): Promise<void> {
  await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true })
}

export async function getSubscriptionStatus(
  stripe: Stripe,
  subscriptionId: string
): Promise<{ status: string; cancelAtPeriodEnd: boolean }> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  return { status: subscription.status, cancelAtPeriodEnd: subscription.cancel_at_period_end }
}

export async function createProduct(stripe: Stripe, name: string): Promise<string> {
  const product = await stripe.products.create({ name })
  return product.id
}

export async function createPrice(
  stripe: Stripe,
  productId: string,
  amountCents: number,
  currency: string
): Promise<string> {
  const price = await stripe.prices.create({
    product: productId,
    unit_amount: amountCents,
    currency,
    recurring: { interval: 'month' },
  })
  return price.id
}
