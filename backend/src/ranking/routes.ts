import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { getRanking, getUserProfile } from './service'

export function createRankingRouter(prisma: PrismaClient): Router {
  const router = Router()

  router.get('/api/ranking', async (_req, res) => {
    try {
      const ranking = await getRanking(prisma)
      res.json(ranking)
    } catch (err) {
      console.error('Failed to load ranking:', err)
      res.status(500).json({ error: 'internal_error' })
    }
  })

  router.get('/api/users/:username/profile', async (req, res) => {
    try {
      const profile = await getUserProfile(prisma, req.params.username)
      if (!profile) {
        res.status(404).json({ error: 'user_not_found' })
        return
      }
      res.json(profile)
    } catch (err) {
      console.error('Failed to load user profile:', err)
      res.status(500).json({ error: 'internal_error' })
    }
  })

  return router
}
