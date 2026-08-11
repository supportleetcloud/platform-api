# Practice Platform

## Register a GitHub OAuth App

`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` come from a GitHub OAuth App you register
yourself — there is no shared/default pair, and the backend refuses to boot without them.

1. Go to GitHub → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**.
2. Fill in:
   - **Application name**: anything (e.g. `practice-platform (local)`)
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:4000/auth/github/callback`
3. Click **Register application**, then **Generate a new client secret**.
4. Copy the **Client ID** and **Client Secret** into `backend/.env` as `GITHUB_CLIENT_ID`
   and `GITHUB_CLIENT_SECRET`.

The callback URL must match `GITHUB_CALLBACK_URL` in `backend/.env` exactly — GitHub rejects
the handshake otherwise. Use a separate OAuth App per environment (local, staging, prod).

## Local setup

1. `createdb practice_platform && createdb practice_platform_test`
2. `cp backend/.env.example backend/.env`, then edit it:
   - replace `YOUR_OS_USERNAME` in `DATABASE_URL` with your OS username (`whoami`) — Prisma,
     unlike `psql`, does not fall back to the OS user when the URL omits one
   - fill in `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` from the step above
   - set `SESSION_SECRET` to a random string (required in production; falls back to
     `dev-secret` locally)
3. `cp frontend/.env.local.example frontend/.env.local`
4. `cd backend && npm install && npx prisma migrate dev`
5. Apply the same migrations to the test database:
   `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npx prisma migrate deploy`
6. `cd backend && npm run dev` (port 4000)
7. `cd frontend && npm install && npm run dev` (port 3000)
8. Seed the challenge catalog and (optionally) run the validation engine locally — see
   "Challenges & the validation engine" below.

## Run with Docker

Runs Postgres, the backend, and the frontend in containers — you still need a GitHub OAuth
App (previous section) since the backend refuses to boot without real credentials.

1. `cp backend/.env.example backend/.env`, then fill in `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
   and `SESSION_SECRET` (leave `DATABASE_URL`/`PORT`/`FRONTEND_URL` alone — compose overrides
   those for the container network regardless of what's in the file).
2. `docker compose up --build`
3. Open `http://localhost:3000`.

The backend container runs `prisma migrate deploy` against the compose Postgres on every
start, so migrations apply automatically — no manual `createdb`/`migrate dev` step needed.
Postgres data persists in the `postgres-data` named volume across restarts; `docker compose
down -v` wipes it.

To change `NEXT_PUBLIC_BACKEND_URL` (e.g. deploying frontend/backend on different hosts),
edit the `args.NEXT_PUBLIC_BACKEND_URL` build arg in `docker-compose.yml` — it's baked into
the frontend's client bundle at build time, so a plain runtime env var won't take effect.

## Running tests

Substitute your OS username (`whoami`) for `YOUR_OS_USERNAME`, or use the `$(whoami)` form
below verbatim — `DATABASE_URL` needs an explicit user, same as `backend/.env`.

- Backend: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test`
- Frontend: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test`

## Admin access

Add a comma-separated list of GitHub usernames to `ADMIN_GITHUB_USERNAMES` in `backend/.env`
to grant admin flag on login.

## Challenges & the validation engine

The backend orchestrates challenge runs by calling the Java `validation-engine` service and
receiving results via a webhook it exposes itself — see
`docs/superpowers/specs/2026-08-06-node-orchestrator-design.md` for the full design.

1. Seed the challenge catalog (run once after `prisma migrate dev`, and again whenever a YAML
   file under `backend/challenges/` changes): `cd backend && npm run seed:challenges`
2. Run the validation engine alongside the backend: `cd validation-engine && mvn spring-boot:run`
   (listens on port 8080 by default, matching `VALIDATION_ENGINE_URL`'s default in
   `backend/.env.example`).
3. `WEBHOOK_BASE_URL` must be a host the validation engine can actually reach. The
   `http://localhost:4000` default works when both run on the same machine; in any other
   deployment (e.g. the validation engine on a separate host or container) it needs to be the
   backend's real reachable address.

## AI feedback

Every completed run gets one LLM-generated feedback text, produced by whichever provider an
admin has configured at `/admin/llm-settings` (Claude, OpenAI, OpenRouter, or Ollama) — see
`docs/superpowers/specs/2026-08-07-ai-feedback-engine-design.md` for the full design.

1. Generate a real encryption key for stored provider API keys and set it in `backend/.env`:
   `openssl rand -base64 32`, assigned to `ENCRYPTION_KEY`.
2. Log in with an account listed in `ADMIN_GITHUB_USERNAMES`, then visit `/admin/llm-settings`
   to pick a provider, model, and (for Claude/OpenAI/OpenRouter) an API key — or a base URL
   instead, for a locally-running Ollama.
3. Until a provider is configured, completed runs still work normally — their feedback simply
   resolves to unavailable (`feedbackStatus: "failed"`), never blocking the run itself.

## Billing

Paid access is a Stripe subscription (`checkout.session.completed` grants it,
`customer.subscription.deleted` revokes it) — see
`docs/superpowers/specs/2026-08-11-monetization-design.md` for the full design.

1. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `backend/.env`. Both are required —
   unlike most other config here, there is no dev-safe default: the backend refuses to boot
   without them outside the test environment, precisely so a deploy can never silently accept
   the publicly-known placeholder webhook secret this repo ships in its test suite.
2. In the Stripe dashboard, register a webhook endpoint pointing at
   `<backend-url>/api/webhooks/stripe`, subscribed to exactly two events:
   `checkout.session.completed` and `customer.subscription.deleted`. Copy its signing secret
   into `STRIPE_WEBHOOK_SECRET`.
3. Run `cd backend && npm run seed:billing` once, with real Stripe keys configured, before
   opening signups. This creates the Stripe Product/Price and the single `BillingSettings`
   row the app reads the current price from. Without it, `BillingSettings` has no row and
   every user's "Upgrade" button returns `503 not_configured` indefinitely — the admin can
   also set/change the price later at `/admin/billing` without rerunning the seed script.

## Terms of Use

Every user must accept the current Terms of Use — checkbox + version + timestamp — before
submitting a challenge run; see `docs/superpowers/specs/2026-08-10-tos-design.md` for the
full design.

1. Log in with an account listed in `ADMIN_GITHUB_USERNAMES`, then visit `/admin/tos` to
   publish the first version. Until a version is published, no one is gated.
2. Publishing a new version requires every user (including ones who already accepted an
   older version) to accept again the next time `/api/me` is checked, before
   `POST /api/runs` will succeed for them.
3. Editing the text is never destructive — every publish creates a new, permanent version;
   old versions and who accepted them are kept for audit purposes.
