# Monetization (Stripe / Freemium) + Admin Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `User.isPaid` becomes real (driven by a Stripe subscription) instead of a permanent stub. A free user upgrades from the dashboard via Stripe Checkout; a paid user cancels from the dashboard. The monthly price is admin-configurable, never hardcoded, and a price change never touches existing subscribers' locked-in price.

**Architecture:** Stripe Checkout (hosted page) for subscribing — no Stripe.js, no card form, no publishable key anywhere in the frontend. A webhook (`checkout.session.completed`, `customer.subscription.deleted`) is the only thing that flips `User.isPaid`. A new `backend/src/billing/` module holds the Stripe SDK boundary (`stripe.ts`), business logic (`service.ts`), user-facing routes (`routes.ts`), and the webhook route (`webhook.ts`). Admin price configuration extends the existing `admin/routes.ts`. External SDK calls are dependency-injected (a `Stripe` client instance passed as a parameter), matching the codebase's existing `fetchImpl`/`prisma` injection convention — never a module-level `jest.mock`.

**Tech Stack:** Node.js + TypeScript, Express, Prisma (Postgres), Jest + Supertest (backend); Next.js + Vitest + Testing Library (frontend); `stripe` npm package (new dependency).

## Global Constraints

- Monthly billing only, USD only — no annual plan, no currency selection (design spec, "Scope").
- Seed price is $9.99/mo (999 cents), editable afterward from the admin panel — never hardcoded elsewhere (design spec, "Goal").
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` live in env vars only, never in the database — same tier as `SESSION_SECRET`/`ENCRYPTION_KEY`, fail-fast in production if unset (design spec, "Backend").
- No Stripe.js, no card element, no publishable key in the frontend — the only client-side billing action is a redirect to a Stripe-hosted Checkout URL returned by the backend (design spec, "Frontend").
- `isPaid` only ever flips to `false` on the `customer.subscription.deleted` webhook event — never on `invoice.payment_failed` or any other event (design spec, "Backend" / decided during brainstorming).
- Cancellation is `cancel_at_period_end: true`, triggered by an in-app "Cancel subscription" button — no redirect to Stripe's hosted Customer Portal, no resume-after-cancel action (design spec, "Frontend").
- No webhook event-id dedupe table — `applyWebhookEvent`'s two transitions are naturally idempotent (design spec, "Backend").
- Billing UI lives on the existing `dashboard` page as one more panel (same precedent as the `hideFromRanking` checkbox) — no dedicated `/billing` route (design spec, "Frontend").
- No upgrade CTA / lock icons on the challenges catalog or `challenges/[id]` — the existing `free_tier_limit` error already surfaces via the generic error handler there; that's unchanged by this feature (design spec, "Scope").
- Code style matches the existing codebase exactly: no semicolons, single quotes, 2-space indent (both `backend/` and `frontend/`); dependencies injected via factory functions (`createXRouter(prisma, ...)`); backend tests run against a real Postgres test database via Prisma; frontend tests mock `global.fetch` and `next/navigation`.
- Every test that creates `User`/`BillingSettings` rows scopes its cleanup to its own IDs — `User` is shared by many other test files across the suite (never a bare `deleteMany({})` on it); `BillingSettings` is a true singleton (`id: 'singleton'`) shared across the whole billing test surface, so every billing test file's `afterEach` deletes it explicitly rather than assuming a clean slate.

---

## Task 1: Data model — `User` billing columns + `BillingSettings`

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `User.stripeCustomerId: string | null`, `User.stripeSubscriptionId: string | null` (existing `User.isPaid` unchanged in shape, now driven by real writes instead of a permanent stub); `BillingSettings` model (`id`, `stripeProductId`, `stripePriceId`, `amountCents`, `currency`, `updatedAt`) — used by every later task.

- [ ] **Step 1: Add the columns and the new model**

Modify `backend/prisma/schema.prisma` — add two fields to the existing `User` model, right after `hideFromRanking`, and one new model at the end of the file:

```prisma
model User {
  id        String   @id @default(uuid())
  githubId  String   @unique
  username  String
  avatarUrl String?
  isAdmin   Boolean  @default(false)
  isPaid    Boolean  @default(false)
  hideFromRanking Boolean @default(false)
  stripeCustomerId     String? @unique
  stripeSubscriptionId String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  runs           Run[]
  tosAcceptances TosAcceptance[]
}
```

```prisma
model BillingSettings {
  id              String   @id
  stripeProductId String
  stripePriceId   String
  amountCents     Int
  currency        String   @default("usd")
  updatedAt       DateTime @updatedAt
}
```

- [ ] **Step 2: Migrate**

Run:
```bash
cd backend && npx prisma migrate dev --name add_billing
```
Expected: a new folder under `backend/prisma/migrations/`, no drift warning.

Apply to the test database too:
```bash
DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npx prisma migrate deploy
```

- [ ] **Step 3: Confirm the existing suite still passes**

Run: `cd backend && npm test`
Expected: all existing tests green — these two nullable/defaulted columns and one new unused table don't touch any existing behavior.

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "feat: add Stripe billing columns and BillingSettings model"
```

---

## Task 2: `stripe` dependency + env wiring + `createApp` DI

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/.env.example`
- Modify: `backend/tests/jest.setup.ts`
- Modify: `backend/src/app.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `createApp(deps: { prisma?, fetchImpl?, stripeClient?: Stripe })` — every later backend task that needs a Stripe client gets it via `deps.stripeClient` in tests, or the real one `app.ts` constructs from `STRIPE_SECRET_KEY` otherwise. `STRIPE_WEBHOOK_SECRET` (string) available in `app.ts` for Task 5 to thread into the webhook router.

- [ ] **Step 1: Add the `stripe` dependency**

```bash
cd backend && npm install stripe@^22.5.0
```
Expected: `backend/package.json` dependencies gain `"stripe": "^22.5.0"`, `backend/package-lock.json` updates.

- [ ] **Step 2: Add env vars**

Modify `backend/.env.example`, append:
```
STRIPE_SECRET_KEY=""
STRIPE_WEBHOOK_SECRET=""
```

- [ ] **Step 3: Add test-only defaults**

Modify `backend/tests/jest.setup.ts`, append at the end (mirrors the existing `ENCRYPTION_KEY` comment/fallback style):
```ts
// STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET: not real Stripe credentials. The secret key is
// only used to construct a Stripe SDK client — tests that need to hit the (mocked) API inject
// their own fake `stripeClient` via `createApp({ stripeClient })` instead of relying on this
// one. The webhook secret IS exercised for real by billing.webhook.test.ts, which uses
// Stripe's own `Stripe.webhooks.generateTestHeaderString` helper to sign payloads against this
// exact value — that's pure local HMAC verification, no network call, safe to run in CI.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_deterministic_placeholder'
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_deterministic_placeholder'
```

- [ ] **Step 4: Wire `stripeClient` into `createApp`, fail-fast in production**

Modify `backend/src/app.ts`. Add the import at the top:
```ts
import Stripe from 'stripe'
```

Change the `deps` parameter and add the client construction, right after the existing `ENCRYPTION_KEY` fail-fast block:
```ts
export function createApp(deps: { prisma?: PrismaClient; fetchImpl?: typeof fetch; stripeClient?: Stripe } = {}) {
  const prisma = deps.prisma ?? defaultPrisma
  const fetchImpl = deps.fetchImpl ?? fetch
  const app = express()
```
...(existing `cors`, `express.json`, `ENCRYPTION_KEY` checks unchanged)...
```ts
  // Fail fast rather than booting a production deploy where checkout/cancel silently 502s
  // and the webhook silently 400s on every real Stripe event.
  if (process.env.NODE_ENV === 'production' && !process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is required in production')
  }
  if (process.env.NODE_ENV === 'production' && !process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is required in production')
  }

  const stripe = deps.stripeClient ?? new Stripe(process.env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder')
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_test_placeholder'
```

Leave `stripe` and `stripeWebhookSecret` unused for now — Tasks 4/5/6 wire them into routers. `backend/tsconfig.json` has neither `noUnusedLocals` nor `noUnusedParameters` set, so this compiles cleanly in the meantime.

- [ ] **Step 5: Verify it still compiles and boots**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

Run: `cd backend && npm test`
Expected: all existing tests still green (the health check in particular — `createApp()` with no args must still boot cleanly with the placeholder Stripe key).

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/.env.example backend/tests/jest.setup.ts backend/src/app.ts
git commit -m "feat: add stripe dependency and env wiring"
```

---

## Task 3: `billing/stripe.ts` + `billing/service.ts` — core business logic

**Files:**
- Create: `backend/src/billing/stripe.ts`
- Create: `backend/src/billing/service.ts`
- Test: `backend/tests/billing.service.test.ts`

**Interfaces:**
- Consumes: `Task 1`'s `User.stripeCustomerId`/`stripeSubscriptionId`/`isPaid`, `BillingSettings`; a `Stripe` client instance (constructed in `app.ts`, Task 2).
- Produces (used by Tasks 4, 5, 6):
  - `stripe.ts`: `createCheckoutSession(stripe, input): Promise<{ url: string }>`, `constructWebhookEvent(rawBody, signature, webhookSecret): WebhookEvent`, `cancelSubscription(stripe, subscriptionId): Promise<void>`, `getSubscriptionStatus(stripe, subscriptionId): Promise<{ status: string; cancelAtPeriodEnd: boolean }>`, `createProduct(stripe, name): Promise<string>`, `createPrice(stripe, productId, amountCents, currency): Promise<string>`.
  - `service.ts`: `getBillingStatus(prisma, stripe, userId): Promise<BillingStatus>`, `startCheckout(prisma, stripe, userId, frontendUrl): Promise<StartCheckoutResult>`, `requestCancellation(prisma, stripe, userId): Promise<CancelResult>`, `applyWebhookEvent(prisma, event): Promise<void>`, `getAdminBillingSettings(prisma): Promise<{priceCents, currency} | null>`, `updatePrice(prisma, stripe, amountCents): Promise<UpdatePriceResult>`.

- [ ] **Step 1: Write `billing/stripe.ts`**

Create `backend/src/billing/stripe.ts`:
```ts
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
```

- [ ] **Step 2: Write the failing test for `service.ts`**

Create `backend/tests/billing.service.test.ts`:
```ts
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
      await applyWebhookEvent(prisma, { kind: 'subscription_deleted', customerId: 'cus_test_paid' })

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

    it('is a no-op for ignored events', async () => {
      await expect(applyWebhookEvent(prisma, { kind: 'ignored' })).resolves.toBeUndefined()
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && npx jest tests/billing.service.test.ts`
Expected: FAIL — `Cannot find module '../src/billing/service'`.

- [ ] **Step 4: Write `billing/service.ts`**

Create `backend/src/billing/service.ts`:
```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx jest tests/billing.service.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/billing/stripe.ts backend/src/billing/service.ts backend/tests/billing.service.test.ts
git commit -m "feat: add billing service layer (Stripe checkout, cancel, webhook apply, admin price)"
```

---

## Task 4: `billing/routes.ts` — end-user HTTP layer

**Files:**
- Create: `backend/src/billing/routes.ts`
- Test: `backend/tests/billing.routes.test.ts`

**Interfaces:**
- Consumes: `service.ts`'s `getBillingStatus`/`startCheckout`/`requestCancellation` (Task 3); `requireAuth` (`backend/src/auth/middleware.ts`, existing).
- Produces: `createBillingRouter(prisma: PrismaClient, stripe: Stripe, config: { frontendUrl: string }): Router` — mounted in `app.ts` by Task 5.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/billing.routes.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest tests/billing.routes.test.ts`
Expected: FAIL — routes don't exist yet (404s / `createApp` doesn't accept `stripeClient` meaningfully for routing yet).

- [ ] **Step 3: Write `billing/routes.ts`**

Create `backend/src/billing/routes.ts`:
```ts
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
```

Modify `backend/src/app.ts` — add the import and mount the router (right after `createRunsWebhookRouter`'s mount, before `createAdminRouter`):
```ts
import { createBillingRouter } from './billing/routes'
```
```ts
  app.use(createBillingRouter(prisma, stripe, { frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000' }))
```
`stripeWebhookSecret` (from Task 2) is still unused at this point — Task 5 consumes it next.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest tests/billing.routes.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/billing/routes.ts backend/src/app.ts backend/tests/billing.routes.test.ts
git commit -m "feat: add end-user billing routes (status, checkout-session, cancel)"
```

---

## Task 5: `billing/webhook.ts` + raw-body `app.ts` fix

**Files:**
- Create: `backend/src/billing/webhook.ts`
- Test: `backend/tests/billing.webhook.test.ts`
- Modify: `backend/src/app.ts`

**Interfaces:**
- Consumes: `stripe.ts`'s `constructWebhookEvent` (Task 3), `service.ts`'s `applyWebhookEvent` (Task 3), `stripeWebhookSecret` (Task 2).
- Produces: `createBillingWebhookRouter(prisma: PrismaClient, webhookSecret: string): Router`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/billing.webhook.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest tests/billing.webhook.test.ts`
Expected: FAIL — `/api/webhooks/stripe` doesn't exist yet (404s).

- [ ] **Step 3: Write `billing/webhook.ts`**

Create `backend/src/billing/webhook.ts`:
```ts
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
```

- [ ] **Step 4: Fix the raw-body ordering and mount the router in `app.ts`**

Modify `backend/src/app.ts`. Add the import:
```ts
import { createBillingWebhookRouter } from './billing/webhook'
```

Change this existing line:
```ts
  app.use(express.json())
```
to (raw body for the Stripe webhook must be captured *before* the global JSON parser runs — Express body-parsers set `req._body = true` after parsing and skip a request that's already parsed, so this only affects the one path):
```ts
  app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }))
  app.use(express.json())
```

Mount the webhook router next to the billing router (Task 4's line):
```ts
  app.use(createBillingRouter(prisma, stripe, { frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000' }))
  app.use(createBillingWebhookRouter(prisma, stripeWebhookSecret))
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx jest tests/billing.webhook.test.ts`
Expected: PASS, all four cases green.

Run the full backend suite to confirm the raw-body reordering didn't break any other route's JSON body parsing:
Run: `cd backend && npm test`
Expected: all tests green, including `runs.webhook.test.ts`, `auth.routes.test.ts`, and every route that posts a JSON body.

- [ ] **Step 6: Commit**

```bash
git add backend/src/billing/webhook.ts backend/src/app.ts backend/tests/billing.webhook.test.ts
git commit -m "feat: add Stripe webhook route with raw-body signature verification"
```

---

## Task 6: Admin pricing routes

**Files:**
- Modify: `backend/src/admin/routes.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/tests/admin.routes.test.ts`

**Interfaces:**
- Consumes: `service.ts`'s `getAdminBillingSettings`/`updatePrice` (Task 3); `requireAuth`/`requireAdmin` (existing).
- Produces: `GET`/`PUT /api/admin/billing-settings`, admin-only — consumed by Task 10 (admin frontend page).

- [ ] **Step 1: Write the failing tests**

Modify `backend/tests/admin.routes.test.ts` — add a new `describe` block at the end of the file (after the existing `GET/POST /api/admin/tos/versions` block), and add the `Stripe`/fake-client imports at the top:
```ts
import Stripe from 'stripe'
```
```ts
function fakeStripe(overrides: Record<string, unknown> = {}): Stripe {
  return {
    checkout: { sessions: { create: jest.fn() } },
    subscriptions: { update: jest.fn(), retrieve: jest.fn() },
    products: { create: jest.fn() },
    prices: { create: jest.fn() },
    ...overrides,
  } as unknown as Stripe
}

describe('GET/PUT /api/admin/billing-settings', () => {
  const BILLING_ADMIN_USER_ID = 'admin-routes-billing-test-admin'
  const BILLING_NON_ADMIN_USER_ID = 'admin-routes-billing-test-non-admin'
  const SETTINGS_ID = 'singleton'

  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: BILLING_ADMIN_USER_ID },
      update: { isAdmin: true },
      create: { id: BILLING_ADMIN_USER_ID, githubId: 'gh-admin-routes-billing-admin', username: 'admin-octocat', isAdmin: true },
    })
    await prisma.user.upsert({
      where: { id: BILLING_NON_ADMIN_USER_ID },
      update: { isAdmin: false },
      create: { id: BILLING_NON_ADMIN_USER_ID, githubId: 'gh-admin-routes-billing-plain', username: 'plain-octocat', isAdmin: false },
    })
  })

  afterEach(async () => {
    await prisma.billingSettings.deleteMany({ where: { id: SETTINGS_ID } })
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: BILLING_ADMIN_USER_ID } }).catch(() => {})
    await prisma.user.delete({ where: { id: BILLING_NON_ADMIN_USER_ID } }).catch(() => {})
    await prisma.$disconnect()
  })

  beforeEach(() => {
    mockAuthUser = { id: BILLING_ADMIN_USER_ID, isAdmin: true }
  })

  it('GET returns 401 when not authenticated', async () => {
    const app = createApp({ prisma })
    const res = await request(app).get('/api/admin/billing-settings')
    expect(res.status).toBe(401)
  })

  it('GET returns 403 for an authenticated non-admin', async () => {
    mockAuthUser = { id: BILLING_NON_ADMIN_USER_ID, isAdmin: false }
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/admin/billing-settings')
    expect(res.status).toBe(403)
  })

  it('GET returns null before any price has been set', async () => {
    const app = createApp({ prisma })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.get('/api/admin/billing-settings')
    expect(res.status).toBe(200)
    expect(res.body).toBeNull()
  })

  it('PUT sets the price and GET reflects it', async () => {
    const createProductMock = jest.fn().mockResolvedValue({ id: 'prod_admin_test' })
    const createPriceMock = jest.fn().mockResolvedValue({ id: 'price_admin_test' })
    const app = createApp({
      prisma,
      stripeClient: fakeStripe({ products: { create: createProductMock }, prices: { create: createPriceMock } }),
    })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const put = await agent.put('/api/admin/billing-settings').send({ amountCents: 1999 })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ priceCents: 1999, currency: 'usd' })

    const after = await agent.get('/api/admin/billing-settings')
    expect(after.body).toEqual({ priceCents: 1999, currency: 'usd' })
  })

  it('PUT returns 400 for a non-positive amountCents', async () => {
    const app = createApp({ prisma, stripeClient: fakeStripe() })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.put('/api/admin/billing-settings').send({ amountCents: 0 })
    expect(res.status).toBe(400)
  })

  it('PUT returns 403 for an authenticated non-admin', async () => {
    mockAuthUser = { id: BILLING_NON_ADMIN_USER_ID, isAdmin: false }
    const app = createApp({ prisma, stripeClient: fakeStripe() })
    const agent = request.agent(app)
    await agent.get('/auth/github/callback')

    const res = await agent.put('/api/admin/billing-settings').send({ amountCents: 999 })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest tests/admin.routes.test.ts`
Expected: FAIL on the new `billing-settings` block — `createAdminRouter` doesn't take a `stripe` argument yet and the routes don't exist.

- [ ] **Step 3: Extend `admin/routes.ts` and its call site**

Modify `backend/src/admin/routes.ts` — add imports and change the function signature:
```ts
import Stripe from 'stripe'
import { getAdminBillingSettings, updatePrice } from '../billing/service'
```
```ts
export function createAdminRouter(prisma: PrismaClient, stripe: Stripe): Router {
```

Add two routes, after the existing `POST /api/admin/tos/versions` route and before `return router`:
```ts
  router.get('/api/admin/billing-settings', requireAuth, requireAdmin, async (_req, res) => {
    const settings = await getAdminBillingSettings(prisma)
    res.json(settings)
  })

  router.put('/api/admin/billing-settings', requireAuth, requireAdmin, async (req, res) => {
    const amountCents = req.body?.amountCents
    const result = await updatePrice(prisma, stripe, amountCents)

    if (result.kind === 'validation_error') {
      res.status(400).json({ error: result.error })
      return
    }
    res.json({ priceCents: result.priceCents, currency: result.currency })
  })
```

Modify `backend/src/app.ts` — update the call site:
```ts
  app.use(createAdminRouter(prisma, stripe))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest tests/admin.routes.test.ts`
Expected: PASS, both the existing `llm-settings`/`tos` blocks and the new `billing-settings` block green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/admin/routes.ts backend/src/app.ts backend/tests/admin.routes.test.ts
git commit -m "feat: add admin billing price configuration routes"
```

---

## Task 7: `/api/me` gains `isPaid`

**Files:**
- Modify: `backend/src/users/routes.ts`
- Modify: `backend/tests/me.routes.test.ts`

**Interfaces:**
- Consumes: `User.isPaid` (existing column, now real per Task 3's webhook writes).
- Produces: `GET /api/me` response gains `isPaid: boolean` — used by Task 9's dashboard (informationally; the billing panel itself reads from `/api/billing/status`, not this field).

- [ ] **Step 1: Write the failing test**

Modify `backend/tests/me.routes.test.ts` — find the existing test asserting the shape of a successful `GET /api/me` response and extend its expectation to include `isPaid: false`. If the file asserts the full body with `toEqual`, add the field there; also add one new test:
```ts
it('GET /api/me includes isPaid', async () => {
  const app = createApp({ prisma })
  const agent = request.agent(app)
  await agent.get('/auth/github/callback')

  const res = await agent.get('/api/me')
  expect(res.body.isPaid).toBe(false)
})
```
(Match this file's existing `agent`/`mockAuthUser`/user-fixture setup conventions exactly — read the file first to place this inside the right `describe` block and reuse its existing test user id rather than introducing a new one.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest tests/me.routes.test.ts`
Expected: FAIL — `res.body.isPaid` is `undefined`.

- [ ] **Step 3: Add the field**

Modify `backend/src/users/routes.ts` — extend the `select` and the returned object inside `buildMeResponse`:
```ts
    const dbUser = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { hideFromRanking: true, isPaid: true },
    })

    return {
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin,
      tosAcceptanceRequired,
      hideFromRanking: dbUser.hideFromRanking,
      isPaid: dbUser.isPaid,
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest tests/me.routes.test.ts`
Expected: PASS.

Run the full backend suite once more — other tests (`dashboard`-adjacent backend tests, if any assert `/api/me`'s exact shape elsewhere) should still pass since this is an additive field:
Run: `cd backend && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/users/routes.ts backend/tests/me.routes.test.ts
git commit -m "feat: add isPaid to GET /api/me"
```

---

## Task 8: `seed-billing.ts`

**Files:**
- Create: `backend/scripts/seed-billing.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes: `stripe.ts`'s `createProduct`/`createPrice` (Task 3); real `PrismaClient` (`backend/src/db/client.ts`, existing).
- Produces: a populated `BillingSettings` singleton row when run against a real Stripe account — no interface other code depends on (CLI entry point only).

- [ ] **Step 1: Write the script**

Create `backend/scripts/seed-billing.ts` (`createProduct`/`createPrice` come from `src/billing/stripe.ts`, not `service.ts`):
```ts
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
```

- [ ] **Step 2: Add the npm script**

Modify `backend/package.json`, add next to the existing `"seed:challenges"` entry:
```json
    "seed:billing": "ts-node scripts/seed-billing.ts",
```

- [ ] **Step 3: Verify it compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors. (Do not run the script for real here — it would call the live Stripe API with whatever `STRIPE_SECRET_KEY` is in `backend/.env`; running it is a deploy-time step, not part of this task's verification.)

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/seed-billing.ts backend/package.json
git commit -m "feat: add seed-billing script to bootstrap the Stripe Product/Price"
```

---

## Task 9: Dashboard billing panel

**Files:**
- Modify: `frontend/app/dashboard/page.tsx`
- Modify: `frontend/tests/dashboard.test.tsx`

**Interfaces:**
- Consumes: `GET /api/billing/status` (Task 4), `POST /api/billing/checkout-session` (Task 4), `POST /api/billing/cancel` (Task 4), `useResource`/`backendFetch` (`frontend/app/lib/api.ts`, existing).
- Produces: nothing consumed by later tasks (this is the last consumer of the billing API on the free/paid end-user side).

- [ ] **Step 1: Write the failing tests**

Modify `frontend/tests/dashboard.test.tsx` in full — replace the file's contents with:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import DashboardPage from '../app/dashboard/page'

const replaceMock = vi.fn()
let searchParamsValue = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => searchParamsValue,
}))

const ME_RESPONSE = {
  id: '1',
  username: 'octocat',
  avatarUrl: null,
  isAdmin: false,
  tosAcceptanceRequired: false,
  hideFromRanking: false,
  isPaid: false,
}
const CHALLENGES_RESPONSE = [
  { id: 'todo-api-crud', title: 'Build a Todo CRUD API', category: 'crud', points: 25 },
]
const FREE_BILLING_STATUS = { isPaid: false, priceCents: 999, currency: 'usd', cancelAtPeriodEnd: false }
const PAID_BILLING_STATUS = { isPaid: true, priceCents: 999, currency: 'usd', cancelAtPeriodEnd: false }

function mockFetch(routes: Record<string, { status: number; json?: unknown }>) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const key = Object.keys(routes).find((k) => {
      const hasMethod = k.includes(' ')
      const routeMethod = hasMethod ? k.split(' ')[0] : 'GET'
      const routePath = hasMethod ? k.split(' ')[1] : k
      return method === routeMethod && url.includes(routePath)
    })
    const route = key ? routes[key] : { status: 500 }
    return Promise.resolve({ status: route.status, json: async () => route.json })
  }) as any
}

describe('DashboardPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
    searchParamsValue = new URLSearchParams()
  })

  it('shows the username when the session is valid', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/welcome, octocat/i)).toBeInTheDocument()
    })
  })

  it('renders a Ranking link pointing to /ranking', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/welcome, octocat/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: 'Ranking' })).toHaveAttribute('href', '/ranking')
  })

  it('redirects to the login page when the session is missing', async () => {
    mockFetch({
      'GET /api/me': { status: 401 },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 401 },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/')
    })
  })

  it('shows an error message instead of an infinite spinner when the backend request fails', async () => {
    mockFetch({
      'GET /api/me': { status: 500 },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 500 },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/something went wrong loading your dashboard/i)).toBeInTheDocument()
    })

    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
  })

  it('renders the challenge list', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: CHALLENGES_RESPONSE },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/build a todo crud api/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: /build a todo crud api/i })).toHaveAttribute(
      'href',
      '/challenges/todo-api-crud'
    )
  })

  it('shows a message when the challenge list fails to load', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 500 },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/could not load challenges/i)).toBeInTheDocument()
    })
  })

  it('redirects to /accept-terms when ToS acceptance is required', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: { ...ME_RESPONSE, tosAcceptanceRequired: true } },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/accept-terms')
    })
  })

  it('toggles hideFromRanking via PUT /api/me and reflects the new value', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
      'PUT /api/me': { status: 200, json: { ...ME_RESPONSE, hideFromRanking: true } },
    })
    const user = userEvent.setup()

    render(<DashboardPage />)
    await waitFor(() => screen.getByLabelText(/hide from public ranking/i))

    const checkbox = screen.getByLabelText(/hide from public ranking/i) as HTMLInputElement
    expect(checkbox.checked).toBe(false)

    await user.click(checkbox)

    await waitFor(() => {
      expect(checkbox.checked).toBe(true)
    })

    const putCall = (global.fetch as any).mock.calls.find(
      (call: any[]) => call[0].includes('/api/me') && call[1]?.method === 'PUT'
    )
    expect(JSON.parse(putCall[1].body)).toEqual({ hideFromRanking: true })
  })

  it('reverts the checkbox and shows an error when the PUT fails', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
      'PUT /api/me': { status: 500 },
    })
    const user = userEvent.setup()

    render(<DashboardPage />)
    await waitFor(() => screen.getByLabelText(/hide from public ranking/i))

    const checkbox = screen.getByLabelText(/hide from public ranking/i) as HTMLInputElement
    await user.click(checkbox)

    await waitFor(() => {
      expect(checkbox.checked).toBe(false)
    })
    expect(screen.getByText(/could not save/i)).toBeInTheDocument()
  })

  it('shows the free plan panel with an Upgrade button', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/free plan/i)).toBeInTheDocument()
      expect(screen.getByText(/\$9\.99\/mo/)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /upgrade/i })).toBeInTheDocument()
  })

  it('redirects to the Stripe checkout url on Upgrade click', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
      'POST /api/billing/checkout-session': { status: 200, json: { url: 'https://checkout.stripe.test/xyz' } },
    })
    const user = userEvent.setup()
    delete (window as any).location
    ;(window as any).location = { href: '' }

    render(<DashboardPage />)
    await waitFor(() => screen.getByRole('button', { name: /upgrade/i }))

    await user.click(screen.getByRole('button', { name: /upgrade/i }))

    await waitFor(() => {
      expect(window.location.href).toBe('https://checkout.stripe.test/xyz')
    })
  })

  it('shows the pro plan panel with a Cancel subscription button, gated by an inline confirm', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: { ...ME_RESPONSE, isPaid: true } },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: PAID_BILLING_STATUS },
      'POST /api/billing/cancel': { status: 200, json: { canceled: true } },
    })
    const user = userEvent.setup()

    render(<DashboardPage />)
    await waitFor(() => screen.getByText(/pro plan/i))

    expect(screen.queryByText(/are you sure/i)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /cancel subscription/i }))
    expect(screen.getByText(/are you sure/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /confirm cancel/i }))

    await waitFor(() => {
      expect(screen.getByText(/cancels at the end of the current billing period/i)).toBeInTheDocument()
    })
  })

  it('shows the activating banner when redirected back with ?checkout=success', async () => {
    searchParamsValue = new URLSearchParams('checkout=success')
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/subscription activating/i)).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run tests/dashboard.test.tsx`
Expected: FAIL on every new billing-panel test, and likely on the pre-existing ones too until `GET /api/billing/status` is wired into the page (they'll hang or error on the extra fetch route not being handled by the still-unaware component — that's fine, confirms the starting state).

- [ ] **Step 3: Extend `dashboard/page.tsx`**

Replace `frontend/app/dashboard/page.tsx` in full:
```tsx
'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useResource, useTosGate, backendFetch } from '../lib/api'
import TopBar from '../components/TopBar'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
  tosAcceptanceRequired: boolean
  hideFromRanking: boolean
  isPaid: boolean
}

type Challenge = {
  id: string
  title: string
  category: string
  points: number
}

type BillingStatus = {
  isPaid: boolean
  priceCents: number | null
  currency: string | null
  cancelAtPeriodEnd: boolean
}

export default function DashboardPage() {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const challenges = useResource<Challenge[]>('/api/challenges')
  const billing = useResource<BillingStatus>('/api/billing/status')
  const searchParams = useSearchParams()
  useTosGate(me)

  const [hideFromRanking, setHideFromRanking] = useState(false)
  const [savingRanking, setSavingRanking] = useState(false)
  const [rankingError, setRankingError] = useState<string | null>(null)

  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null)
  const [upgradeSaving, setUpgradeSaving] = useState(false)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [cancelSaving, setCancelSaving] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  useEffect(() => {
    if (me.data) setHideFromRanking(me.data.hideFromRanking)
  }, [me.data])

  useEffect(() => {
    if (billing.data) setBillingStatus(billing.data)
  }, [billing.data])

  function handleToggleRanking(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.checked
    setHideFromRanking(next)
    setRankingError(null)
    setSavingRanking(true)

    backendFetch('/api/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hideFromRanking: next }),
    })
      .then((res) => {
        if (res.status === 200) {
          setSavingRanking(false)
          return
        }
        setHideFromRanking(!next)
        setRankingError('Could not save preference.')
        setSavingRanking(false)
      })
      .catch(() => {
        setHideFromRanking(!next)
        setRankingError('Could not save preference.')
        setSavingRanking(false)
      })
  }

  function handleUpgrade() {
    setUpgradeError(null)
    setUpgradeSaving(true)

    backendFetch('/api/billing/checkout-session', { method: 'POST' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 200) {
          window.location.href = body.url
          return
        }
        setUpgradeError(body.error === 'not_configured' ? "Billing isn't set up yet." : 'Could not start checkout.')
        setUpgradeSaving(false)
      })
      .catch(() => {
        setUpgradeError('Could not start checkout.')
        setUpgradeSaving(false)
      })
  }

  function handleCancel() {
    setCancelError(null)
    setCancelSaving(true)

    backendFetch('/api/billing/cancel', { method: 'POST' })
      .then((res) => {
        if (res.status === 200) {
          setConfirmingCancel(false)
          setCancelSaving(false)
          setBillingStatus((prev) => (prev ? { ...prev, cancelAtPeriodEnd: true } : prev))
          return
        }
        setCancelError('Could not cancel subscription.')
        setCancelSaving(false)
      })
      .catch(() => {
        setCancelError('Could not cancel subscription.')
        setCancelSaving(false)
      })
  }

  if (me.loading) return <p className="state-message">Loading...</p>
  if (me.error) return <p className="state-message">Something went wrong loading your dashboard.</p>
  if (!me.data) return null

  const priceLabel =
    billingStatus?.priceCents != null ? `$${(billingStatus.priceCents / 100).toFixed(2)}/mo` : null

  return (
    <div className="page">
      <TopBar location="dashboard" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content">
        <div>
          <h1 className="page-title">Welcome, {me.data.username}</h1>
          <p className="page-subtitle">Pick a challenge, submit your API&apos;s URL, watch the checks run.</p>
        </div>

        {searchParams.get('checkout') === 'success' && (
          <p className="state-message">
            Subscription activating — this can take a few seconds. Refresh if your plan doesn&apos;t update.
          </p>
        )}

        <div>
          <p className="section-label" style={{ marginBottom: 'var(--space-3)' }}>
            Challenges
          </p>
          {challenges.loading && <p className="muted">Loading challenges...</p>}
          {challenges.error && <p className="form-error">Could not load challenges.</p>}
          {challenges.data && (
            <ul className="challenge-list">
              {challenges.data.map((challenge) => (
                <li key={challenge.id}>
                  <a className="challenge-row" href={`/challenges/${challenge.id}`}>
                    <span className="challenge-row-title">{challenge.title}</span>
                    <span className="challenge-row-meta">
                      <span className="badge-category">{challenge.category}</span>
                      <span className="challenge-row-points">{challenge.points} pts</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="section-label" style={{ marginBottom: 'var(--space-3)' }}>
            Billing
          </p>
          {billing.loading && <p className="muted">Loading billing status...</p>}
          {billing.error && <p className="form-error">Could not load billing status.</p>}
          {billingStatus && !billingStatus.isPaid && (
            <div>
              <p>Free plan{priceLabel ? ` — ${priceLabel} unlocks the full catalog and unlimited attempts.` : '.'}</p>
              <button onClick={handleUpgrade} disabled={upgradeSaving}>
                Upgrade
              </button>
              {upgradeError && <p className="form-error">{upgradeError}</p>}
            </div>
          )}
          {billingStatus && billingStatus.isPaid && !billingStatus.cancelAtPeriodEnd && (
            <div>
              <p>Pro plan — active</p>
              {!confirmingCancel && (
                <button onClick={() => setConfirmingCancel(true)}>Cancel subscription</button>
              )}
              {confirmingCancel && (
                <div>
                  <p>Are you sure?</p>
                  <button onClick={handleCancel} disabled={cancelSaving}>
                    Confirm cancel
                  </button>
                  <button onClick={() => setConfirmingCancel(false)}>Never mind</button>
                </div>
              )}
              {cancelError && <p className="form-error">{cancelError}</p>}
            </div>
          )}
          {billingStatus && billingStatus.isPaid && billingStatus.cancelAtPeriodEnd && (
            <p>Pro plan — cancels at the end of the current billing period.</p>
          )}
        </div>

        <div>
          <label className="field-checkbox">
            <input
              type="checkbox"
              checked={hideFromRanking}
              onChange={handleToggleRanking}
              disabled={savingRanking}
            />
            Hide from public ranking
          </label>
          {rankingError && <p className="form-error">{rankingError}</p>}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/dashboard.test.tsx`
Expected: PASS, all cases (existing + new) green.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/dashboard/page.tsx frontend/tests/dashboard.test.tsx
git commit -m "feat: add billing panel to dashboard (upgrade, cancel, activating banner)"
```

---

## Task 10: Admin billing page + `TopBar` link

**Files:**
- Create: `frontend/app/admin/billing/page.tsx`
- Test: `frontend/tests/admin-billing.test.tsx`
- Modify: `frontend/app/components/TopBar.tsx`

**Interfaces:**
- Consumes: `GET`/`PUT /api/admin/billing-settings` (Task 6), `useResource`/`backendFetch` (existing).
- Produces: nothing consumed by later tasks — this is the plan's last task.

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/admin-billing.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminBillingPage from '../app/admin/billing/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}))

const ADMIN_ME = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: true }
const NON_ADMIN_ME = { id: '2', username: 'someone', avatarUrl: null, isAdmin: false }
const SETTINGS = { priceCents: 999, currency: 'usd' }

function mockFetch(routes: {
  me?: { status: number; json?: unknown }
  get?: { status: number; json?: unknown }
  put?: { status: number; json?: unknown }
}) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const isMe = url.includes('/api/me')
    const isPut = init?.method === 'PUT'
    const route = isMe ? routes.me : isPut ? routes.put : routes.get
    const status = route?.status ?? 500
    return Promise.resolve({ status, json: async () => route?.json })
  }) as any
}

describe('AdminBillingPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
  })

  it('shows "Not authorized." for a non-admin user', async () => {
    mockFetch({ me: { status: 200, json: NON_ADMIN_ME }, get: { status: 200, json: SETTINGS } })

    render(<AdminBillingPage />)

    await waitFor(() => {
      expect(screen.getByText('Not authorized.')).toBeInTheDocument()
    })
  })

  it('renders the form pre-filled with the current price for an admin', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: SETTINGS } })

    render(<AdminBillingPage />)

    await waitFor(() => {
      expect(screen.getByDisplayValue('9.99')).toBeInTheDocument()
    })
  })

  it('renders an empty price field when billing is not configured yet', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: null } })

    render(<AdminBillingPage />)

    await waitFor(() => {
      expect(screen.getByLabelText(/monthly price/i)).toBeInTheDocument()
    })
    expect((screen.getByLabelText(/monthly price/i) as HTMLInputElement).value).toBe('')
  })

  it('saves successfully, converting dollars to cents, and shows a confirmation', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: SETTINGS },
      put: { status: 200, json: { priceCents: 1999, currency: 'usd' } },
    })
    const user = userEvent.setup()

    render(<AdminBillingPage />)
    await waitFor(() => screen.getByDisplayValue('9.99'))

    await user.clear(screen.getByLabelText(/monthly price/i))
    await user.type(screen.getByLabelText(/monthly price/i), '19.99')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(screen.getByText('Price saved.')).toBeInTheDocument()
    })

    const putCall = (global.fetch as any).mock.calls.find((call: any[]) => call[1]?.method === 'PUT')
    expect(JSON.parse(putCall[1].body)).toEqual({ amountCents: 1999 })
  })

  it('shows the server error message on a validation failure', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: SETTINGS },
      put: { status: 400, json: { error: 'amountCents must be a positive integer' } },
    })
    const user = userEvent.setup()

    render(<AdminBillingPage />)
    await waitFor(() => screen.getByDisplayValue('9.99'))

    await user.clear(screen.getByLabelText(/monthly price/i))
    await user.type(screen.getByLabelText(/monthly price/i), '0')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(screen.getByText('amountCents must be a positive integer')).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run tests/admin-billing.test.tsx`
Expected: FAIL — `../app/admin/billing/page` doesn't exist yet.

- [ ] **Step 3: Write the admin billing page**

Create `frontend/app/admin/billing/page.tsx`:
```tsx
'use client'

import { useEffect, useState } from 'react'
import { useResource, backendFetch } from '../../lib/api'
import TopBar from '../../components/TopBar'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
}

type BillingSettings = {
  priceCents: number
  currency: string
} | null

export default function AdminBillingPage() {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const settings = useResource<BillingSettings>('/api/admin/billing-settings')

  const [price, setPrice] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (settings.data) {
      setPrice((settings.data.priceCents / 100).toFixed(2))
    }
  }, [settings.data])

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaveError(null)
    setSaved(false)
    setSaving(true)

    const amountCents = Math.round(parseFloat(price) * 100)

    backendFetch('/api/admin/billing-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 200) {
          setSaved(true)
          setSaving(false)
          return
        }
        setSaveError(body.error ?? 'Could not save price.')
        setSaving(false)
      })
      .catch(() => {
        setSaveError('Could not save price.')
        setSaving(false)
      })
  }

  if (me.loading || settings.loading) return <p className="state-message">Loading...</p>
  if (me.error) return <p className="state-message">Something went wrong loading this page.</p>
  if (!me.data) return null
  if (!me.data.isAdmin) return <p className="state-message">Not authorized.</p>
  if (settings.error) return <p className="state-message">Could not load billing settings.</p>

  return (
    <div className="page">
      <TopBar location="admin / billing" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content content-narrow">
        <div>
          <h1 className="page-title">Billing</h1>
          <p className="page-subtitle">Set the monthly subscription price.</p>
        </div>

        <form className="panel" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label" htmlFor="price">
              Monthly price (USD)
            </label>
            <input
              id="price"
              type="number"
              step="0.01"
              min="0.01"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </div>

          <button type="submit" disabled={saving}>
            Save
          </button>
          {saved && <p className="form-success">Price saved.</p>}
          {saveError && <p className="form-error">{saveError}</p>}
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Add the `TopBar` link**

Modify `frontend/app/components/TopBar.tsx` — add one line inside the existing `isAdmin` block, after the `/admin/tos` link:
```tsx
          {isAdmin && (
            <>
              <span className="topbar-admin-tag">admin</span>
              <a href="/admin/llm-settings">LLM</a>
              <a href="/admin/tos">ToS</a>
              <a href="/admin/billing">Billing</a>
            </>
          )}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/admin-billing.test.tsx`
Expected: PASS, all cases green.

Run the full frontend suite to confirm the `TopBar` change didn't break any other page's snapshot/text assertions:
Run: `cd frontend && npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/admin/billing/page.tsx frontend/tests/admin-billing.test.tsx frontend/app/components/TopBar.tsx
git commit -m "feat: add admin billing price page and TopBar link"
```

---

## Final check

- [ ] Run the full backend suite: `cd backend && npm test` — expect all green.
- [ ] Run the full frontend suite: `cd frontend && npm test` — expect all green.
- [ ] Run `cd backend && npx tsc --noEmit` and `cd frontend && npx tsc --noEmit` (if a frontend typecheck script/config exists — otherwise `next build` covers it) — expect no type errors.
- [ ] Manually confirm `backend/.env.example` documents `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, and that a real deploy runs `npm run seed:billing` once, with real Stripe keys set, before opening signups.
