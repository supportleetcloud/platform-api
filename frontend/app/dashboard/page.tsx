'use client'

import { useResource } from '../lib/api'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
}

type Challenge = {
  id: string
  title: string
  category: string
  points: number
}

export default function DashboardPage() {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const challenges = useResource<Challenge[]>('/api/challenges')

  if (me.loading) return <p>Loading...</p>
  if (me.error) return <p>Something went wrong loading your dashboard.</p>
  if (!me.data) return null

  return (
    <main>
      <h1>Welcome, {me.data.username}</h1>
      {me.data.isAdmin && <p>Admin access enabled</p>}
      <a href={`${process.env.NEXT_PUBLIC_BACKEND_URL}/auth/logout`}>Logout</a>

      <h2>Challenges</h2>
      {challenges.loading && <p>Loading challenges...</p>}
      {challenges.error && <p>Could not load challenges.</p>}
      {challenges.data && (
        <ul>
          {challenges.data.map((challenge) => (
            <li key={challenge.id}>
              <a href={`/challenges/${challenge.id}`}>
                {challenge.title} ({challenge.category}, {challenge.points} pts)
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
