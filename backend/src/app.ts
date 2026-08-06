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

export function createApp(deps: { prisma?: PrismaClient } = {}) {
  const prisma = deps.prisma ?? defaultPrisma
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

  app.use(authRouter)
  app.use(meRouter)
  app.use(createChallengesRouter(prisma))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  return app
}
