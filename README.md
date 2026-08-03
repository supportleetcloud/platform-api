# Practice Platform

## Local setup

1. `createdb practice_platform && createdb practice_platform_test`
2. `cp backend/.env.example backend/.env` and fill in `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`.
3. `cp frontend/.env.local.example frontend/.env.local`
4. `cd backend && npm install && npx prisma migrate dev`
5. `cd backend && npm run dev` (port 4000)
6. `cd frontend && npm install && npm run dev` (port 3000)

## Running tests

- Backend: `cd backend && DATABASE_URL="postgresql://localhost:5432/practice_platform_test" npm test`
- Frontend: `cd frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:4000 npm test`

## Admin access

Add a comma-separated list of GitHub usernames to `ADMIN_GITHUB_USERNAMES` in `backend/.env` to grant admin flag on login.
