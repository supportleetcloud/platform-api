'use client'

import { useResource } from '../lib/api'
import TopBar from '../components/TopBar'

type RankingEntry = {
  userId: string
  username: string
  avatarUrl: string | null
  totalScore: number
  challengesAttempted: number
}

export default function RankingPage() {
  const ranking = useResource<RankingEntry[]>('/api/ranking')

  if (ranking.loading) return <p className="state-message">Loading...</p>
  if (ranking.error) return <p className="state-message">Could not load the ranking.</p>
  if (!ranking.data) return null

  return (
    <div className="page">
      <TopBar />
      <div className="content">
        <div>
          <h1 className="page-title">Ranking</h1>
          <p className="page-subtitle">Sum of each user&apos;s best score per challenge attempted.</p>
        </div>

        {ranking.data.length === 0 ? (
          <p className="muted">No one has completed a challenge yet.</p>
        ) : (
          <ul className="challenge-list">
            {ranking.data.map((entry, index) => (
              <li key={entry.userId}>
                <a className="challenge-row" href={`/u/${entry.username}`}>
                  <span className="challenge-row-title">
                    #{index + 1} {entry.username}
                  </span>
                  <span className="challenge-row-meta">
                    <span className="badge-category">{entry.challengesAttempted} challenges</span>
                    <span className="challenge-row-points">{entry.totalScore} pts</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
