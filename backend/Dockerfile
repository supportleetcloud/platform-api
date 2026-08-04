# syntax=docker/dockerfile:1

FROM node:20-slim AS deps
WORKDIR /app
# Prisma's engine can't detect OpenSSL on a bare node:20-slim and falls
# back to guessing the version — install it explicitly instead.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
# Dummy value so `prisma generate` (runs via postinstall during `npm ci`)
# can resolve env("DATABASE_URL") in schema.prisma without a real DB.
ENV DATABASE_URL="postgresql://placeholder@localhost:5432/placeholder"
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY backend/prisma backend/prisma
RUN npm ci

FROM deps AS build
COPY backend backend
RUN npm run build --workspace=backend

FROM node:20-slim AS runtime
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
# npm did not hoist prisma/@prisma/client to the root — they landed in
# backend/node_modules. Without this, `npx prisma` at runtime finds no
# local bin and silently downloads latest from the registry instead.
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY backend/package.json backend/package.json
COPY backend/prisma backend/prisma
WORKDIR /app/backend
EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
