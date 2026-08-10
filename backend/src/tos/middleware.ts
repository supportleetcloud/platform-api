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
    if (await isTosAcceptanceRequired(prisma, user.id)) {
      res.status(403).json({ error: 'tos_required' })
      return
    }
    next()
  }
}
