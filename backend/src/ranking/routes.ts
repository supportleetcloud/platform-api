import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { getRanking, getUserProfile } from './service'

export function createRankingRouter(prisma: PrismaClient): Router {
  const router = Router()

  router.get('/api/ranking', async (_req, res) => {
    const ranking = await getRanking(prisma)
    res.json(ranking)
  })

  router.get('/api/users/:username/profile', async (req, res) => {
    const profile = await getUserProfile(prisma, req.params.username)
    if (!profile) {
      res.status(404).json({ error: 'user_not_found' })
      return
    }
    res.json(profile)
  })

  return router
}
