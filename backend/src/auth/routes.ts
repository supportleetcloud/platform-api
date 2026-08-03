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
    req.session.destroy((destroyErr) => {
      if (destroyErr) {
        // The user still gets logged out client-side regardless (cookie cleared, redirected)
        // — don't leave them stuck mid-logout over a server-side cleanup failure. But don't
        // silently swallow it either: a failed destroy() means the session row survives in
        // the connect-pg-simple store, which is worth knowing about.
        console.error('Failed to destroy session on logout:', destroyErr)
      }
      res.clearCookie('connect.sid')
      res.redirect(process.env.FRONTEND_URL ?? '/')
    })
  })
})
