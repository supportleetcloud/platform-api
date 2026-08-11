// Test-only defaults so `npm test` (with just DATABASE_URL set, per the brief) passes
// without requiring undocumented env vars. Only fills in values that aren't already set,
// so real values (e.g. from a developer's shell or CI secrets) always win.
//
// GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_CALLBACK_URL: passport-github2's
// Strategy (via passport-oauth2) throws synchronously if clientID is falsy, and
// configurePassport() constructs that Strategy every time createApp() runs — including
// for suites that never touch auth (e.g. health.test.ts). These never need to be real
// GitHub credentials for tests: passport.authenticate is mocked in auth.routes.test.ts,
// and no other test drives a real OAuth handshake.
//
// SESSION_SECRET: app.ts already falls back to 'dev-secret' when unset, so this is just
// here for parity/explicitness in the test environment, not because anything would break
// without it.
process.env.GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'test-client-id'
process.env.GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || 'test-client-secret'
process.env.GITHUB_CALLBACK_URL =
  process.env.GITHUB_CALLBACK_URL || 'http://localhost:4000/auth/github/callback'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
// FRONTEND_URL: auth/routes.ts bakes `failureRedirect` in at router-construction time and
// builds the post-login redirect from this value. Unset, the success redirect would be the
// literal string "undefined/dashboard" — which still satisfies a `toContain('/dashboard')`
// assertion, so tests would pass on a URL no browser could follow. Setting it here keeps
// the asserted redirects realistic.
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000'
// VALIDATION_ENGINE_URL: runs.routes.test.ts asserts the exact URL submitRun() calls
// fetchImpl with (`http://validation-engine.test/runs`), so this has to be a fixed,
// recognizable value rather than app.ts's production default of localhost:8080 — a
// dedicated host makes it obvious in assertions that this is the mocked engine, not a
// real one someone might actually be running on 8080 locally.
process.env.VALIDATION_ENGINE_URL = process.env.VALIDATION_ENGINE_URL || 'http://validation-engine.test'
// ENCRYPTION_KEY: llm/settings.ts's AES-256-GCM encryption requires 32 raw bytes,
// base64-encoded. Deterministic test-only value (not a real secret) so LlmSettings
// tests can encrypt/decrypt without requiring a real deploy-time key.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || Buffer.alloc(32, 7).toString('base64')
// STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET: not real Stripe credentials. The secret key is
// only used to construct a Stripe SDK client — tests that need to hit the (mocked) API inject
// their own fake `stripeClient` via `createApp({ stripeClient })` instead of relying on this
// one. The webhook secret IS exercised for real by billing.webhook.test.ts, which uses
// Stripe's own `Stripe.webhooks.generateTestHeaderString` helper to sign payloads against this
// exact value — that's pure local HMAC verification, no network call, safe to run in CI.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_deterministic_placeholder'
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_deterministic_placeholder'
