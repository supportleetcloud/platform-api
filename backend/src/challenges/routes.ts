import { Router } from 'express'
import { PrismaClient } from '@prisma/client'

export function createChallengesRouter(prisma: PrismaClient): Router {
  const router = Router()

  router.get('/api/challenges', async (_req, res) => {
    const challenges = await prisma.challenge.findMany({
      where: { archived: false },
      select: { id: true, title: true, category: true, points: true },
      orderBy: { createdAt: 'asc' },
    })
    res.json(challenges)
  })

  router.get('/api/challenges/:id', async (req, res) => {
    const challenge = await prisma.challenge.findFirst({
      where: { id: req.params.id, archived: false },
      select: {
        id: true,
        title: true,
        category: true,
        points: true,
        description: true,
        objective: true,
        technicalDetails: true,
      },
    })

    if (!challenge) {
      res.status(404).json({ error: 'challenge_not_found' })
      return
    }

    res.json(challenge)
  })

  return router
}
