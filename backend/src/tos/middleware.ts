import { Request, Response, NextFunction } from 'express'
import { PrismaClient } from '@prisma/client'
import { isTosAcceptanceRequired } from './service'

export function requireTosAccepted(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as { id: string } | undefined
    if (!user) {
      res.status(401).json({ error: 'not_authenticated' })
      return
    }
    try {
      if (await isTosAcceptanceRequired(prisma, user.id)) {
        res.status(403).json({ error: 'tos_required' })
        return
      }
    } catch (err) {
      console.error(`Failed to determine tosAcceptanceRequired for user ${user.id}:`, err)
      res.status(500).json({ error: 'internal_error' })
      return
    }
    next()
  }
}
