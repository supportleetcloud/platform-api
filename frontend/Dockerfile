# syntax=docker/dockerfile:1

FROM node:20-slim AS deps
WORKDIR /app
# Dummy value so backend's `prisma generate` postinstall (runs for every
# workspace on `npm ci` in this monorepo) can resolve env("DATABASE_URL").
ENV DATABASE_URL="postgresql://placeholder@localhost:5432/placeholder"
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY backend/prisma backend/prisma
COPY frontend/package.json frontend/package.json
RUN npm ci

FROM deps AS build
# Next.js inlines NEXT_PUBLIC_* vars into the client bundle at build time,
# so this must be a build arg, not just a runtime compose `environment:`.
ARG NEXT_PUBLIC_BACKEND_URL=http://localhost:4000
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL
COPY frontend frontend
RUN npm run build --workspace=frontend

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/frontend/.next ./frontend/.next
COPY frontend/package.json frontend/package.json
COPY frontend/next.config.js frontend/next.config.js
WORKDIR /app/frontend
EXPOSE 3000
CMD ["npm", "run", "start"]
