'use client'

import { useResource, useTosGate } from '../lib/api'
import TopBar from '../components/TopBar'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
  tosAcceptanceRequired: boolean
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
  useTosGate(me)

  if (me.loading) return <p className="state-message">Loading...</p>
  if (me.error) return <p className="state-message">Something went wrong loading your dashboard.</p>
  if (!me.data) return null

  return (
    <div className="page">
      <TopBar location="dashboard" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content">
        <div>
          <h1 className="page-title">Welcome, {me.data.username}</h1>
          <p className="page-subtitle">Pick a challenge, submit your API&apos;s URL, watch the checks run.</p>
        </div>

        <div>
          <p className="section-label" style={{ marginBottom: 'var(--space-3)' }}>
            Challenges
          </p>
          {challenges.loading && <p className="muted">Loading challenges...</p>}
          {challenges.error && <p className="form-error">Could not load challenges.</p>}
          {challenges.data && (
            <ul className="challenge-list">
              {challenges.data.map((challenge) => (
                <li key={challenge.id}>
                  <a className="challenge-row" href={`/challenges/${challenge.id}`}>
                    <span className="challenge-row-title">{challenge.title}</span>
                    <span className="challenge-row-meta">
                      <span className="badge-category">{challenge.category}</span>
                      <span className="challenge-row-points">{challenge.points} pts</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
