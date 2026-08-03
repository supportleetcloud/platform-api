import passport from 'passport'
import { Strategy as GitHubStrategy } from 'passport-github2'
import { PrismaClient } from '@prisma/client'
import { findOrCreateUserByGithubProfile } from '../users/service'

// `passport` is a process-wide singleton. `passport.use()` overwrites the registered
// strategy and `serializeUser`/`deserializeUser` *append* to unbounded internal arrays, so
// calling configurePassport() once per createApp() (as tests do) grew global state on every
// call and silently re-pointed every previously-built app's verify callback at whichever
// PrismaClient was passed last. Making this idempotent means the first caller wins: each
// test file gets a fresh module registry, so `createApp({ prisma })` still configures
// passport with its own injected client, and repeat createApp() calls are no-ops.
let configured = false

export function configurePassport(prisma: PrismaClient) {
  if (configured) return
  configured = true

  // passport-oauth2 throws a bare `TypeError: OAuth2Strategy requires a clientID option`
  // on an empty clientID, which gives no hint that the fix is filling in backend/.env.
  // `.env.example` ships these blank, so an unconfigured checkout hits this on first boot.
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    throw new Error(
      'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set (see backend/.env). ' +
        'Register a GitHub OAuth App and copy its credentials in — see "Register a GitHub ' +
        'OAuth App" in the README.'
    )
  }

  passport.use(
    new GitHubStrategy(
      {
        clientID: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL: process.env.GITHUB_CALLBACK_URL ?? '',
        // Login-CSRF protection. A truthy non-string `state` switches passport-oauth2 from
        // its NullStore to the session-backed nonce store (passport-oauth2/lib/strategy.js
        // ~L109), which mints a random state per authorization request, stashes it in
        // req.session and rejects a callback whose `state` doesn't match. Without it an
        // attacker can replay their own GitHub authorization code into a victim's session.
        //
        // Two notes:
        //  - This belongs on the *strategy constructor*, not on passport.authenticate():
        //    the store is chosen in the constructor, and authenticate() only honours `state`
        //    when it's a string (i.e. a fixed, attacker-guessable value — useless here).
        //  - @types/passport-github2 narrows `state` to `string | undefined` and so can't
        //    express the boolean form; the cast is what the runtime actually wants.
        state: true as unknown as string,
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
