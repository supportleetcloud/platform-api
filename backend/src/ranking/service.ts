import { PrismaClient } from '@prisma/client'

export type RankingEntry = {
  userId: string
  username: string
  avatarUrl: string | null
  totalScore: number
  challengesAttempted: number
}

export async function getRanking(prisma: PrismaClient): Promise<RankingEntry[]> {
  const grouped = await prisma.run.groupBy({
    by: ['userId', 'challengeId'],
    where: { status: 'completed' },
    _max: { score: true },
  })

  const totals = new Map<string, { totalScore: number; challengesAttempted: number }>()
  for (const row of grouped) {
    if (row._max.score === null) continue
    const current = totals.get(row.userId) ?? { totalScore: 0, challengesAttempted: 0 }
    current.totalScore += row._max.score
    current.challengesAttempted += 1
    totals.set(row.userId, current)
  }

  if (totals.size === 0) return []

  const users = await prisma.user.findMany({
    where: { id: { in: [...totals.keys()] }, hideFromRanking: false },
    select: { id: true, username: true, avatarUrl: true },
  })

  const entries: RankingEntry[] = users.map((user) => {
    const total = totals.get(user.id)!
    return {
      userId: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      totalScore: total.totalScore,
      challengesAttempted: total.challengesAttempted,
    }
  })

  entries.sort((a, b) => b.totalScore - a.totalScore || a.username.localeCompare(b.username))
  return entries
}

export type UserProfile = {
  username: string
  avatarUrl: string | null
  totalScore: number
  rank: number
  challenges: { challengeId: string; title: string; category: string; points: number; bestScore: number }[]
}

export async function getUserProfile(prisma: PrismaClient, username: string): Promise<UserProfile | null> {
  const user = await prisma.user.findFirst({ where: { username }, orderBy: { updatedAt: 'desc' } })
  if (!user || user.hideFromRanking) return null

  const grouped = await prisma.run.groupBy({
    by: ['challengeId'],
    where: { userId: user.id, status: 'completed' },
    _max: { score: true },
  })

  const scoredRows = grouped.filter((row) => row._max.score !== null)
  const challengeIds = scoredRows.map((row) => row.challengeId)
  const challenges = challengeIds.length
    ? await prisma.challenge.findMany({ where: { id: { in: challengeIds } } })
    : []

  const challengeList = scoredRows
    .map((row) => {
      const challenge = challenges.find((c) => c.id === row.challengeId)!
      return {
        challengeId: challenge.id,
        title: challenge.title,
        category: challenge.category,
        points: challenge.points,
        bestScore: row._max.score!,
      }
    })
    .sort((a, b) => b.bestScore - a.bestScore || a.challengeId.localeCompare(b.challengeId))

  // rank and totalScore are both read from this user's entry in the same list getRanking()
  // produces — reusing getRanking() here (rather than re-deriving the score independently)
  // guarantees the two are always one consistent snapshot, not just coincidentally in sync.
  const ranking = await getRanking(prisma)
  const position = ranking.findIndex((entry) => entry.userId === user.id)
  const rank = position === -1 ? 0 : position + 1
  const totalScore = position === -1 ? 0 : ranking[position].totalScore

  return {
    username: user.username,
    avatarUrl: user.avatarUrl,
    totalScore,
    rank,
    challenges: challengeList,
  }
}
