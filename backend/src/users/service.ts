import { PrismaClient, User } from '@prisma/client'

export function isAllowlistedAdmin(username: string): boolean {
  const admins = (process.env.ADMIN_GITHUB_USERNAMES ?? '')
    .split(',')
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean)

  return admins.includes(username.toLowerCase())
}

export type GithubProfileInput = {
  id: string
  username: string
  photos?: { value: string }[]
}

export async function findOrCreateUserByGithubProfile(
  prisma: PrismaClient,
  profile: GithubProfileInput
): Promise<User> {
  const isAdmin = isAllowlistedAdmin(profile.username)
  const avatarUrl = profile.photos?.[0]?.value

  return prisma.user.upsert({
    where: { githubId: profile.id },
    update: { username: profile.username, avatarUrl, isAdmin },
    create: {
      githubId: profile.id,
      username: profile.username,
      avatarUrl,
      isAdmin,
    },
  })
}
