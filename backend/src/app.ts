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

  app.use(
    session({
      store: new PgSession({ pool: sessionPool, createTableIfMissing: true }),
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

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  return app
}
