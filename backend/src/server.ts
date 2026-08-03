// MUST be the first import: it populates process.env from backend/.env before any other
// module is evaluated. `configurePassport()` constructs the GitHub strategy at import time
// and passport-oauth2 throws `OAuth2Strategy requires a clientID option` on a falsy
// clientID, so loading .env any later crashes `npm run dev` on boot.
//
// This lives in server.ts and NOT in app.ts on purpose: tests import app.ts directly and
// control their own env via tests/jest.setup.ts — they must not pick up a developer's
// local .env (which points at the non-test database).
import 'dotenv/config'

import { createApp } from './app'

const port = process.env.PORT ?? 4000
const app = createApp()

app.listen(port, () => {
  console.log(`backend listening on port ${port}`)
})
