import 'dotenv/config'
import Stripe from 'stripe'
import { prisma } from '../src/db/client'
import { createProduct, createPrice } from '../src/billing/stripe'

const SETTINGS_ID = 'singleton'
const SEED_AMOUNT_CENTS = 999
const SEED_CURRENCY = 'usd'

async function main() {
  const existing = await prisma.billingSettings.findUnique({ where: { id: SETTINGS_ID } })
  if (existing) {
    console.log('BillingSettings already configured, skipping.')
    return
  }

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set')
  }
  const stripe = new Stripe(secretKey)

  const stripeProductId = await createProduct(stripe, 'LetCode Pro')
  const stripePriceId = await createPrice(stripe, stripeProductId, SEED_AMOUNT_CENTS, SEED_CURRENCY)

  await prisma.billingSettings.create({
    data: {
      id: SETTINGS_ID,
      stripeProductId,
      stripePriceId,
      amountCents: SEED_AMOUNT_CENTS,
      currency: SEED_CURRENCY,
    },
  })

  console.log(`Billing seeded: $${(SEED_AMOUNT_CENTS / 100).toFixed(2)}/mo ${SEED_CURRENCY.toUpperCase()}.`)
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (err) => {
    console.error('Failed to seed billing settings:', err)
    await prisma.$disconnect()
    process.exit(1)
  })
