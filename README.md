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

## Running tests

Substitute your OS username (`whoami`) for `YOUR_OS_USERNAME`, or use the `$(whoami)` form
below verbatim — `DATABASE_URL` needs an explicit user, same as `backend/.env`.

- Backend: `cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/practice_platform_test" npm test`
- Frontend: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test`

## Admin access

Add a comma-separated list of GitHub usernames to `ADMIN_GITHUB_USERNAMES` in `backend/.env`
to grant admin flag on login.
