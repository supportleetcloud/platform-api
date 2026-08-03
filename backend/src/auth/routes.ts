import { Router } from 'express'
import passport from 'passport'

export const authRouter = Router()

authRouter.get('/auth/github', passport.authenticate('github', { scope: ['user:email'] }))

authRouter.get(
  '/auth/github/callback',
  passport.authenticate('github', { failureRedirect: '/' }),
  (_req, res) => {
    res.redirect(`${process.env.FRONTEND_URL}/dashboard`)
  }
)

authRouter.get('/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err)
    req.session.destroy(() => {
      res.clearCookie('connect.sid')
      res.redirect(process.env.FRONTEND_URL ?? '/')
    })
  })
})
