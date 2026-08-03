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
