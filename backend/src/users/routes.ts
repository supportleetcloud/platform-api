import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { requireAuth } from '../auth/middleware'
import { isTosAcceptanceRequired } from '../tos/service'

type AuthenticatedUser = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
}

export function createMeRouter(prisma: PrismaClient): Router {
  const router = Router()

  async function buildMeResponse(user: AuthenticatedUser) {
    let tosAcceptanceRequired = false
    try {
      tosAcceptanceRequired = await isTosAcceptanceRequired(prisma, user.id)
    } catch (err) {
      console.error(`Failed to determine tosAcceptanceRequired for user ${user.id}:`, err)
    }

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
  }

  router.get('/api/me', requireAuth, async (req, res) => {
    const user = req.user as AuthenticatedUser
    res.json(await buildMeResponse(user))
  })

  router.put('/api/me', requireAuth, async (req, res) => {
    const user = req.user as AuthenticatedUser
    const hideFromRanking = req.body?.hideFromRanking

    if (typeof hideFromRanking !== 'boolean') {
      res.status(400).json({ error: 'hideFromRanking must be a boolean' })
      return
    }

    await prisma.user.update({ where: { id: user.id }, data: { hideFromRanking } })
    res.json(await buildMeResponse(user))
  })

  return router
}
