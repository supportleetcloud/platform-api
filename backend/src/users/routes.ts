import { Router } from 'express'
import { requireAuth } from '../auth/middleware'

export const meRouter = Router()

meRouter.get('/api/me', requireAuth, (req, res) => {
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
  })
})
