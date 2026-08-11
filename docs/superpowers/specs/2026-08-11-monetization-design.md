# Monetization (Stripe / Freemium) + Admin Pricing — Design

> `PLANO_MVP.md`'s "Monetização" and "Painel Admin" item #1 ("Configuração de preço da assinatura"). Builds on the existing `requireAdmin` middleware, the `admin/` module (`docs/superpowers/specs/2026-08-07-ai-feedback-engine-design.md`), and the free-tier gate already implemented in `backend/src/runs/service.ts` (2 challenges / 10 attempts, enforced against `User.isPaid`, which today is a permanent stub always `false`). Does **not** cover annual billing, a resume-after-cancel flow, upgrade CTAs on the challenge catalog/detail pages, or any change to the free-tier gate logic itself — that logic already works and is unmodified by this feature.

## Goal

`User.isPaid` becomes real, driven by a Stripe subscription, instead of a permanent stub. A free user can upgrade from the dashboard via Stripe Checkout; a paid user can cancel from the dashboard. The monthly subscription price is configurable from an admin panel screen, never hardcoded, and changing it never affects existing subscribers' already-active price (Stripe Price objects are immutable — a price change creates a new Price object; existing Subscriptions keep referencing their original one).

## Scope

In scope:
- `User.stripeCustomerId` / `User.stripeSubscriptionId` columns; `User.isPaid` (existing column) becomes Stripe-driven instead of a permanent stub.
- `BillingSettings` singleton (current Stripe Product/Price id + price in cents + currency), admin-configurable.
- Stripe Checkout (hosted page) for subscribing — no Stripe.js, no card form, no publishable key in the frontend.
- `POST /api/billing/checkout-session`, `POST /api/billing/cancel`, `GET /api/billing/status` — end-user billing actions, `requireAuth`.
- `POST /api/webhooks/stripe` — Stripe-initiated, no auth, signature-verified.
- `GET`/`PUT /api/admin/billing-settings` — admin price configuration, mounted in the existing `admin/routes.ts`.
- `backend/scripts/seed-billing.ts` — one-time bootstrap of the Stripe Product + initial $9.99/mo USD Price, mirroring `seed-challenges.ts`.
- Frontend: a "Billing" block on `dashboard` (upgrade / cancel / status), and `frontend/app/admin/billing/page.tsx` (price configuration).
- `TopBar` admin nav gains a `/admin/billing` link.

Explicitly out of scope: annual billing (monthly only — `PLANO_MVP.md` doesn't mention annual and there's no user base yet to justify two plans), a "resume subscription" action after cancellation is scheduled, a dedicated `/billing` route (the billing UI lives on the existing dashboard, matching the `hideFromRanking` checkbox's precedent of one more dashboard block rather than a new page), upgrade prompts/lock icons on the challenges catalog or `challenges/[id]` (the `free_tier_limit` error already surfaces via the existing generic error handler there — prettifying it is separate work), a Stripe customer-facing invoice/receipt history view, tax collection, promo codes, and any webhook event-id dedupe store (see "Webhook idempotency" below for why).

## Data Model (additions to `backend/prisma/schema.prisma`)

```prisma
model User {
  // ...existing fields unchanged, including isPaid Boolean @default(false)...
  stripeCustomerId     String? @unique
  stripeSubscriptionId String?
}

model BillingSettings {
  id              String   @id                 // always the literal string "singleton"
  stripeProductId String
  stripePriceId   String
  amountCents     Int
  currency        String   @default("usd")
  updatedAt       DateTime @updatedAt
}
```

`stripeCustomerId` is set once, on a user's first successful checkout, and persists across cancel/resubscribe cycles (the Stripe Customer object itself is never deleted). `stripeSubscriptionId` is set on `checkout.session.completed` and cleared on `customer.subscription.deleted` — its presence is *not* used as the gating signal (`isPaid` is), only as the id needed to call `cancelSubscription`/`getSubscriptionStatus`.

`BillingSettings` always has zero or one row. Zero rows means "not yet configured" — `startCheckout` returns `not_configured` in that state (see Backend below); a real deploy runs `seed-billing.ts` once before opening signups, same pattern `TosVersion` establishes for "nothing published yet is a valid, inert state." An admin price change does **not** update this row's `amountCents` in place and reuse the same `stripePriceId` — it calls Stripe to create a *new* Price under the same `stripeProductId`, then overwrites `stripePriceId`/`amountCents` to point at it. The old Price object still exists in Stripe (inactive for new Checkouts, but still referenced by any Subscription created against it), which is exactly how existing subscribers keep their original price per `PLANO_MVP.md`.

## Backend

New module `backend/src/billing/` (`stripe.ts`, `service.ts`, `routes.ts`, `webhook.ts`), following the existing module shape (e.g. `tos/`, `ranking/`).

**`backend/src/billing/stripe.ts`** — the only file that imports the `stripe` npm package. This is the module boundary `PLANO_MVP.md` calls a "PaymentProvider" — the codebase has no precedent for a formal TS `interface` + DI for a swappable provider (the LLM multi-provider dispatch in `llm/providers.ts` is a plain function with a `switch`, not an interface), so this follows that same lightweight convention: a small set of named exports, never called directly from routes. `PLANO_MVP.md` names the four ops `createCheckoutSession`/`handleWebhookEvent`/`cancelSubscription`/`getSubscriptionStatus`; the webhook op is split in two here — `constructWebhookEvent` (below, pure: verify signature, map to a typed event) in this file, and `applyWebhookEvent` (in `service.ts`, the actual "handle" — writes to Postgres) — because the signature-verification/event-mapping half belongs with the rest of the Stripe SDK boundary while the Postgres write belongs with the rest of the business logic, matching how every other op here is split between "talk to Stripe" (this file) and "talk to Postgres + decide what to do" (`service.ts`).

```ts
function client(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set')
  return new Stripe(key)
}

export async function createCheckoutSession(input: {
  userId: string
  customerId: string | null
  priceId: string
  successUrl: string
  cancelUrl: string
}): Promise<{ url: string }>
// mode: 'subscription', line_items: [{ price: priceId, quantity: 1 }],
// client_reference_id: userId, customer: customerId ?? undefined
// (omitting `customer` lets Stripe create one and collect email during Checkout itself)

export type WebhookEvent =
  | { kind: 'checkout_completed'; userId: string; customerId: string; subscriptionId: string }
  | { kind: 'subscription_deleted'; customerId: string }
  | { kind: 'ignored' }

export function constructWebhookEvent(rawBody: Buffer, signature: string): WebhookEvent
// stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET) — throws on
// bad signature, caller (webhook.ts) turns that into a 400. Maps checkout.session.completed and
// customer.subscription.deleted to the two typed variants above; every other event type -> 'ignored'.

export async function cancelSubscription(subscriptionId: string): Promise<void>
// stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true })

export async function getSubscriptionStatus(subscriptionId: string): Promise<{ status: string; cancelAtPeriodEnd: boolean }>
// stripe.subscriptions.retrieve(subscriptionId) -> { status: sub.status, cancelAtPeriodEnd: sub.cancel_at_period_end }

export async function createProduct(name: string): Promise<string>   // returns product id
export async function createPrice(productId: string, amountCents: number, currency: string): Promise<string>
// stripe.prices.create({ product: productId, unit_amount: amountCents, currency, recurring: { interval: 'month' } })
```

**`backend/src/billing/service.ts`**

```ts
export type BillingStatus = {
  isPaid: boolean
  priceCents: number | null
  currency: string | null
  cancelAtPeriodEnd: boolean
}
export async function getBillingStatus(prisma: PrismaClient, userId: string): Promise<BillingStatus>

export type StartCheckoutResult =
  | { kind: 'created'; url: string }
  | { kind: 'already_paid' }
  | { kind: 'not_configured' }
export async function startCheckout(
  prisma: PrismaClient, userId: string, frontendUrl: string
): Promise<StartCheckoutResult>

export type CancelResult = { kind: 'canceled' } | { kind: 'no_subscription' }
export async function requestCancellation(prisma: PrismaClient, userId: string): Promise<CancelResult>

export async function applyWebhookEvent(prisma: PrismaClient, event: WebhookEvent): Promise<void>

export async function getAdminBillingSettings(prisma: PrismaClient): Promise<{ priceCents: number; currency: string } | null>

export type UpdatePriceResult =
  | { kind: 'updated'; priceCents: number; currency: string }
  | { kind: 'validation_error'; error: string }
export async function updatePrice(prisma: PrismaClient, amountCents: number): Promise<UpdatePriceResult>
```

- `getBillingStatus` — `priceCents`/`currency` always read from the current `BillingSettings` row (`null`/`null` if unconfigured). `cancelAtPeriodEnd` is **not** denormalized into Postgres: if `user.stripeSubscriptionId` is set, it's a live call to `getSubscriptionStatus`; otherwise `false`. This is a low-traffic, self-service read (one dashboard load), so the extra Stripe round-trip is acceptable and avoids a second source of truth that could drift from Stripe's own state.
- `startCheckout` — `already_paid` if `user.isPaid` is already `true` (no double-subscribe). `not_configured` if `BillingSettings` has no row. Otherwise calls `createCheckoutSession` with `customerId: user.stripeCustomerId ?? null` (reuses the Stripe Customer from a prior subscribe/cancel cycle when one exists), `successUrl = ${frontendUrl}/dashboard?checkout=success`, `cancelUrl = ${frontendUrl}/dashboard?checkout=cancelled`.
- `requestCancellation` — `no_subscription` if `user.stripeSubscriptionId` is null or `user.isPaid` is already `false`. Otherwise calls `cancelSubscription`. Does **not** flip `isPaid` itself — that only happens later, via the `customer.subscription.deleted` webhook when the current billing period actually ends (Stripe's own dunning/retry behavior on the underlying invoice is irrelevant to this path since `cancel_at_period_end` doesn't touch payment retries at all).
- `applyWebhookEvent` — `checkout_completed`: `prisma.user.update({ where: { id: event.userId }, data: { stripeCustomerId: event.customerId, stripeSubscriptionId: event.subscriptionId, isPaid: true } })`. `subscription_deleted`: finds the `User` by `stripeCustomerId: event.customerId` (the event carries no `userId`), sets `isPaid: false, stripeSubscriptionId: null`. `ignored`: no-op. Both branches are naturally idempotent (setting `isPaid: true`/`false` twice is harmless), matching the existing runs webhook's tolerance for redundant calls — no event-id dedupe table is added.
- `updatePrice` — `400`-equivalent `validation_error` if `amountCents` isn't a positive integer. If no `BillingSettings` row exists yet (shouldn't happen after `seed-billing.ts`, but defensive), creates the Stripe Product first via `createProduct`. Otherwise reuses the existing `stripeProductId`, calls `createPrice`, and overwrites `stripePriceId`/`amountCents` on the singleton row.

**Routes — end user** (`requireAuth`, in `billing/routes.ts`):
- `GET /api/billing/status` → `200 BillingStatus`.
- `POST /api/billing/checkout-session` → `200 { url }`; `409 { error: 'already_paid' }`; `503 { error: 'not_configured' }`.
- `POST /api/billing/cancel` → `200 { canceled: true }`; `409 { error: 'no_subscription' }`.

**Routes — admin** (`requireAuth`, `requireAdmin`, added to existing `admin/routes.ts`):
- `GET /api/admin/billing-settings` → `200 { priceCents, currency } | null`.
- `PUT /api/admin/billing-settings` — body `{ amountCents }`. `400 { error }` on `validation_error`; otherwise `200 { priceCents, currency }`.

**Webhook** (`backend/src/billing/webhook.ts`):
```ts
router.post('/api/webhooks/stripe', async (req, res) => {
  const signature = req.headers['stripe-signature']
  let event: WebhookEvent
  try {
    event = constructWebhookEvent(req.body, typeof signature === 'string' ? signature : '')
  } catch {
    res.status(400).json({ error: 'invalid_signature' })
    return
  }
  await applyWebhookEvent(prisma, event)
  res.status(200).json({ received: true })
})
```
`req.body` here is a raw `Buffer`, not parsed JSON — see the `app.ts` change below.

**`app.ts` change** (existing bug this feature exposes, fixed as part of this work): `express.json()` is currently mounted globally before any router, which would consume and JSON-parse the webhook body before `constructWebhookEvent` ever sees the raw bytes it needs to verify the signature against. Fix: mount the raw-body parser for the webhook's exact path *before* the global `express.json()`:
```ts
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }))
app.use(express.json())
```
Express body-parsers set `req._body = true` after parsing and skip re-parsing a request that already has it, so `express.json()` running afterward for this path is a no-op, not a double-parse.

New env vars (`.env.example`): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Both required in production via the same fail-fast pattern `app.ts` already applies to `SESSION_SECRET`/`ENCRYPTION_KEY` (throw at boot, not at first use, so a misconfigured deploy never comes up half-working).

**`backend/scripts/seed-billing.ts`** (new, mirrors `seed-challenges.ts`): if `BillingSettings` has no row, calls `createProduct('LetCode Pro')` then `createPrice(productId, 999, 'usd')` and inserts the singleton row. No-op if a row already exists (safe to re-run).

**`/api/me`** (`users/routes.ts`) gains one field, alongside the existing `hideFromRanking`:
```ts
const dbUser = await prisma.user.findUniqueOrThrow({
  where: { id: user.id },
  select: { hideFromRanking: true, isPaid: true },
})
// ...
isPaid: dbUser.isPaid,
```

## Frontend

**Dashboard** (`frontend/app/dashboard/page.tsx`, extended): a new "Billing" panel below the existing "Hide from public ranking" block, same `panel`/`section-label` classes.
- `useResource<BillingStatus>('/api/billing/status')`.
- Free (`!me.data.isPaid`): "Free plan — $9.99/mo unlocks the full catalog and unlimited attempts" + "Upgrade" button. Click → `POST /api/billing/checkout-session`; on `200`, `window.location.href = body.url`; on `503 not_configured`, shows "Billing isn't set up yet" (defensive — shouldn't happen post-seed).
- Paid, not scheduled to cancel: "Pro plan — active" + "Cancel subscription" button. Click reveals an inline "Are you sure? [Confirm cancel]" state (no `window.confirm()`) → `POST /api/billing/cancel` → refetches `/api/billing/status`.
- Paid, `cancelAtPeriodEnd: true`: "Pro plan — cancels at the end of the current billing period." No further action (no resume flow — out of scope).
- Page reads `?checkout=success` / `?checkout=cancelled` from the URL (via `useSearchParams`) and shows a dismissible banner. Success banner: "Subscription activating — this can take a few seconds. Refresh if your plan doesn't update." (the webhook can lag slightly behind the Checkout redirect; no polling loop is added for this, matching the "keep it simple" bar of the rest of the dashboard).

**`frontend/app/admin/billing/page.tsx`** (new, same shape as `admin/llm-settings/page.tsx`):
- `useResource<Me>('/api/me', { redirectOn401: true })`; `!me.data.isAdmin` renders "Not authorized."
- `useResource<{priceCents, currency} | null>('/api/admin/billing-settings')`.
- One number input, "Monthly price (USD)", pre-filled from `priceCents / 100`; "Save" → `PUT /api/admin/billing-settings` with `amountCents = Math.round(value * 100)`.
- `TopBar.tsx` admin nav gains a link to `/admin/billing`, next to `/admin/tos` and `/admin/llm-settings`.

No Stripe.js, no card element, no publishable key anywhere in the frontend — the only client-side billing action is a redirect to a Stripe-hosted URL returned by the backend.

## Error Handling

Follows the existing per-route try/catch + `{ error: "message" }` pattern — no new global error middleware. The webhook route is the one exception to the "200 unless something's wrong" convention: a bad/missing signature is `400` (the request is malformed, not a server error), everything else it processes is `200` even if the event kind was `ignored` (Stripe retries on non-2xx, and there's nothing to retry for an event we don't act on).

## Testing Strategy

Mirrors the existing suite shape (Jest + Supertest, Prisma injected via `deps`, Stripe SDK calls mocked at the `billing/stripe.ts` boundary; Vitest + Testing Library on the frontend):

- `billing.service.test.ts` — `getBillingStatus` returns `isPaid: false, priceCents: null` with no `BillingSettings` row; returns live `cancelAtPeriodEnd` from a mocked `getSubscriptionStatus` when `stripeSubscriptionId` is set; `startCheckout` returns `already_paid` for a paid user and `not_configured` with no `BillingSettings` row; `requestCancellation` returns `no_subscription` for a free user; `applyWebhookEvent` sets `isPaid: true`/customer+subscription ids on `checkout_completed`, and `isPaid: false`/nulls `stripeSubscriptionId` on `subscription_deleted` (looked up by `stripeCustomerId`); calling either twice is idempotent; `updatePrice` rejects zero/negative/non-integer `amountCents`, and a second call reuses the existing `stripeProductId` while overwriting `stripePriceId`.
- `billing.routes.test.ts` — all three end-user routes require auth (`401`); checkout/cancel return the documented status codes for each `service.ts` result kind.
- `billing.webhook.test.ts` — invalid signature is `400`; a valid `checkout.session.completed` payload results in the expected `User` update; an unrecognized event type still responds `200`.
- `admin.routes.test.ts` (extended) — `GET`/`PUT /api/admin/billing-settings` return `401`/`403`/`200` per the existing admin-route pattern; `PUT` with a non-positive `amountCents` is `400`.
- `me.routes.test.ts` (extended) — `GET /api/me` includes `isPaid`.
- `dashboard.test.tsx` (extended) — free-plan block renders "Upgrade" and redirects `window.location` on click; paid block renders "Cancel subscription", inline confirm gates the actual `POST`; `?checkout=success` renders the activating banner.
- `admin-billing.test.tsx` — unauthorized non-admin sees "Not authorized."; save flow calls `PUT` with `amountCents` converted from the dollar input and reflects the updated price on refetch.

## Open Items for the Implementation Plan

- Exact copy for banners/buttons/confirm states — cosmetic, pin during implementation.
- Whether `seed-billing.ts` needs a `--force` flag to rotate the seeded price in non-prod environments, or is strictly a one-time bootstrap — implementation detail, not a design decision.
- Whether `getBillingStatus`'s live Stripe call needs a timeout/fallback if Stripe is unreachable (e.g. degrade to `cancelAtPeriodEnd: false` rather than 500) — worth deciding during implementation once the existing codebase's general external-call timeout conventions (if any beyond the validation-engine's) are checked.
