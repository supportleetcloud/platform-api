import { PrismaClient, TosVersion } from '@prisma/client'

export async function getCurrentVersion(prisma: PrismaClient): Promise<TosVersion | null> {
  return prisma.tosVersion.findFirst({ orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }] })
}

export async function listVersions(prisma: PrismaClient): Promise<TosVersion[]> {
  return prisma.tosVersion.findMany({ orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }] })
}

export type PublishVersionResult =
  | { kind: 'published'; version: TosVersion }
  | { kind: 'validation_error'; error: string }

export async function publishVersion(prisma: PrismaClient, content: string): Promise<PublishVersionResult> {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { kind: 'validation_error', error: 'content is required' }
  }

  const version = await prisma.tosVersion.create({ data: { content: content.trim() } })
  return { kind: 'published', version }
}

export async function isTosAcceptanceRequired(prisma: PrismaClient, userId: string): Promise<boolean> {
  const current = await getCurrentVersion(prisma)
  if (!current) return false

  const acceptance = await prisma.tosAcceptance.findUnique({
    where: { userId_tosVersionId: { userId, tosVersionId: current.id } },
  })
  return acceptance === null
}

export type AcceptCurrentVersionResult =
  | { kind: 'accepted' }
  | { kind: 'stale_version' }
  | { kind: 'not_configured' }

export async function acceptCurrentVersion(
  prisma: PrismaClient,
  userId: string,
  tosVersionId: string
): Promise<AcceptCurrentVersionResult> {
  const current = await getCurrentVersion(prisma)
  if (!current) return { kind: 'not_configured' }
  if (current.id !== tosVersionId) return { kind: 'stale_version' }

  await prisma.tosAcceptance.upsert({
    where: { userId_tosVersionId: { userId, tosVersionId } },
    update: {},
    create: { userId, tosVersionId },
  })
  return { kind: 'accepted' }
}
