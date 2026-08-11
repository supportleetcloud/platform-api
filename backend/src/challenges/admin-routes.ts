import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import { requireAuth } from '../auth/middleware'
import { requireAdmin } from '../admin/middleware'
import {
  createChallenge,
  updateChallenge,
  setChallengeArchived,
  listAdminChallenges,
  getAdminChallenge,
  ChallengeInput,
} from './service'

function parseChallengeInputBody(body: any): ChallengeInput {
  return {
    title: body?.title,
    description: body?.description,
    objective: body?.objective,
    technicalDetails: body?.technicalDetails,
    category: body?.category,
    checks: Array.isArray(body?.checks) ? body.checks : [],
  }
}

export function createChallengesAdminRouter(prisma: PrismaClient): Router {
  const router = Router()

  router.get('/api/admin/challenges', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const challenges = await listAdminChallenges(prisma)
      res.json(challenges)
    } catch (err) {
      console.error('Failed to list challenges:', err)
      res.status(500).json({ error: 'failed to list challenges' })
    }
  })

  router.get('/api/admin/challenges/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const challenge = await getAdminChallenge(prisma, req.params.id)
      if (!challenge) {
        res.status(404).json({ error: 'challenge_not_found' })
        return
      }
      res.json(challenge)
    } catch (err) {
      console.error('Failed to load challenge:', err)
      res.status(500).json({ error: 'failed to load challenge' })
    }
  })

  router.post('/api/admin/challenges', requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await createChallenge(prisma, parseChallengeInputBody(req.body))
      if (result.kind !== 'saved') {
        res.status(400).json({ error: result.kind === 'validation_error' ? result.error : result.kind })
        return
      }
      res.status(201).json({ challengeId: result.challengeId })
    } catch (err) {
      console.error('Failed to create challenge:', err)
      res.status(500).json({ error: 'failed to create challenge' })
    }
  })

  router.put('/api/admin/challenges/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await updateChallenge(prisma, req.params.id, parseChallengeInputBody(req.body))
      if (result.kind === 'not_found') {
        res.status(404).json({ error: 'challenge_not_found' })
        return
      }
      if (result.kind === 'file_defined') {
        res.status(400).json({ error: 'challenge is file-defined, not editable' })
        return
      }
      if (result.kind === 'validation_error') {
        res.status(400).json({ error: result.error })
        return
      }
      res.json({ challengeId: result.challengeId })
    } catch (err) {
      console.error('Failed to update challenge:', err)
      res.status(500).json({ error: 'failed to update challenge' })
    }
  })

  router.put('/api/admin/challenges/:id/archive', requireAuth, requireAdmin, async (req, res) => {
    try {
      const archived = req.body?.archived
      if (typeof archived !== 'boolean') {
        res.status(400).json({ error: 'archived must be a boolean' })
        return
      }
      const result = await setChallengeArchived(prisma, req.params.id, archived)
      if (result.kind === 'not_found') {
        res.status(404).json({ error: 'challenge_not_found' })
        return
      }
      res.json({ archived })
    } catch (err) {
      console.error('Failed to update challenge archive state:', err)
      res.status(500).json({ error: 'failed to update challenge archive state' })
    }
  })

  return router
}
