import { Request, Response, NextFunction } from 'express'

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = req.user as { isAdmin?: boolean } | undefined
  if (!user?.isAdmin) {
    res.status(403).json({ error: 'admin_required' })
    return
  }
  next()
}
