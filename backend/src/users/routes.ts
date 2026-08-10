import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { requireAuth } from '../auth/middleware'
import { isTosAcceptanceRequired } from '../tos/service'

export function createMeRouter(prisma: PrismaClient): Router {
  const router = Router()

  router.get('/api/me', requireAuth, async (req, res) => {
    const user = req.user as {
      id: string
      username: string
      avatarUrl: string | null
      isAdmin: boolean
    }

    res.json({
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin,
      tosAcceptanceRequired: await isTosAcceptanceRequired(prisma, user.id),
    })
  })

  return router
}
