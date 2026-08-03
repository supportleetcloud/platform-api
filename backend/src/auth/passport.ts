import passport from 'passport'
import { Strategy as GitHubStrategy } from 'passport-github2'
import { PrismaClient } from '@prisma/client'
import { findOrCreateUserByGithubProfile } from '../users/service'

export function configurePassport(prisma: PrismaClient) {
  passport.use(
    new GitHubStrategy(
      {
        clientID: process.env.GITHUB_CLIENT_ID ?? '',
        clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
        callbackURL: process.env.GITHUB_CALLBACK_URL ?? '',
      },
      async (_accessToken: string, _refreshToken: string, profile: any, done: any) => {
        try {
          const user = await findOrCreateUserByGithubProfile(prisma, {
            id: profile.id,
            username: profile.username,
            photos: profile.photos,
          })
          done(null, user)
        } catch (err) {
          done(err as Error)
        }
      }
    )
  )

  passport.serializeUser((user: any, done) => done(null, user.id))
  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await prisma.user.findUnique({ where: { id } })
      done(null, user)
    } catch (err) {
      done(err)
    }
  })
}
