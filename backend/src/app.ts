import express from 'express'
import cors from 'cors'
import session from 'express-session'
import passport from 'passport'
import connectPgSimple from 'connect-pg-simple'
import { Pool } from 'pg'
import { PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from './db/client'
import { configurePassport } from './auth/passport'
import { authRouter } from './auth/routes'
import { meRouter } from './users/routes'
import { createChallengesRouter } from './challenges/routes'
import { createRunsRouter } from './runs/routes'
import { createRunsWebhookRouter } from './runs/webhook'
import { createAdminRouter } from './admin/routes'
import { createTosRouter } from './tos/routes'

function isValidEncryptionKey(value: string | undefined): boolean {
  if (!value) return false
  try {
    return Buffer.from(value, 'base64').length === 32
  } catch {
    return false
  }
}

export function createApp(deps: { prisma?: PrismaClient; fetchImpl?: typeof fetch } = {}) {
  const prisma = deps.prisma ?? defaultPrisma
  const fetchImpl = deps.fetchImpl ?? fetch
  const app = express()

  app.use(
    cors({
      origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
      credentials: true,
    })
  )
  app.use(express.json())

  const PgSession = connectPgSimple(session)
  const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL })

  // Fail fast rather than booting a production deploy on a public, forgeable secret:
  // anyone who reads this repo could otherwise mint valid session cookies.
  if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required in production')
  }

  // Fail fast rather than booting into a state where any admin save of LLM provider
  // settings crashes the whole process: encryptionKey() in llm/settings.ts throws
  // synchronously if ENCRYPTION_KEY doesn't decode to exactly 32 raw bytes, and that
  // throw is not caught anywhere between here and the process boundary.
  if (process.env.ENCRYPTION_KEY !== undefined && !isValidEncryptionKey(process.env.ENCRYPTION_KEY)) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded)')
  }
  if (process.env.NODE_ENV === 'production' && !process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is required in production')
  }

  app.use(
    session({
      // createTableIfMissing is off: the `session` table is owned by Prisma's migration
      // history (prisma/migrations/*_add_session_table). Letting connect-pg-simple create
      // it at runtime put it outside that history, so `prisma migrate dev` saw it as drift
      // and would have generated a DROP for it.
      store: new PgSession({ pool: sessionPool, createTableIfMissing: false }),
      secret: process.env.SESSION_SECRET ?? 'dev-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' },
    })
  )

  configurePassport(prisma)
  app.use(passport.initialize())
  app.use(passport.session())

  const validationEngineUrl = process.env.VALIDATION_ENGINE_URL ?? 'http://localhost:8080'
  const webhookBaseUrl = process.env.WEBHOOK_BASE_URL ?? 'http://localhost:4000'
  const runTimeoutMs = Number(process.env.RUN_TIMEOUT_MS ?? 300000)

  app.use(authRouter)
  app.use(meRouter)
  app.use(createChallengesRouter(prisma))
  app.use(createRunsRouter(prisma, fetchImpl, { validationEngineUrl, webhookBaseUrl, runTimeoutMs }))
  app.use(createRunsWebhookRouter(prisma, fetchImpl))
  app.use(createAdminRouter(prisma))
  app.use(createTosRouter(prisma))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  return app
}
