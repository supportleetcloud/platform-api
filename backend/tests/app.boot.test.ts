import { createApp } from '../src/app'

// Guards against C2: the Stripe placeholder secrets ('sk_test_placeholder',
// 'whsec_test_placeholder') must only be usable when NODE_ENV === 'test'. Every other
// environment — including 'development', which is what docker-compose.yml sets for the
// shipped container — must fail fast at boot rather than silently accept the
// publicly-known placeholder webhook secret, which would let anyone forge a signed
// checkout.session.completed request.
describe('createApp boot-time environment validation', () => {
  it('throws when STRIPE_WEBHOOK_SECRET is unset and NODE_ENV is not "test"', () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET

    process.env.NODE_ENV = 'development'
    delete process.env.STRIPE_WEBHOOK_SECRET

    try {
      expect(() => createApp()).toThrow('STRIPE_WEBHOOK_SECRET is required outside the test environment')
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }
      if (originalWebhookSecret === undefined) {
        delete process.env.STRIPE_WEBHOOK_SECRET
      } else {
        process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret
      }
    }
  })

  it('throws when STRIPE_SECRET_KEY is unset and NODE_ENV is not "test"', () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalSecretKey = process.env.STRIPE_SECRET_KEY

    process.env.NODE_ENV = 'development'
    delete process.env.STRIPE_SECRET_KEY

    try {
      expect(() => createApp()).toThrow('STRIPE_SECRET_KEY is required outside the test environment')
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }
      if (originalSecretKey === undefined) {
        delete process.env.STRIPE_SECRET_KEY
      } else {
        process.env.STRIPE_SECRET_KEY = originalSecretKey
      }
    }
  })
})
