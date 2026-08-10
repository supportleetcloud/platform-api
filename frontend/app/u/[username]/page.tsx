'use client'

import { useResource } from '../../lib/api'
import TopBar from '../../components/TopBar'

type UserProfile = {
  username: string
  avatarUrl: string | null
  totalScore: number
  rank: number
  challenges: { challengeId: string; title: string; category: string; points: number; bestScore: number }[]
}

export default function UserProfilePage({ params }: { params: { username: string } }) {
  const profile = useResource<UserProfile>(`/api/users/${params.username}/profile`)

  if (profile.loading) return <p className="state-message">Loading...</p>
  if (profile.notFound) return <p className="state-message">User not found.</p>
  if (profile.error) return <p className="state-message">Could not load this profile.</p>
  if (!profile.data) return null

  return (
    <div className="page">
      <TopBar />
      <div className="content content-narrow">
        <div>
          <h1 className="page-title">{profile.data.username}</h1>
          <p className="page-subtitle">
            {profile.data.rank > 0 ? (
              <>
                Rank #{profile.data.rank} &middot; {profile.data.totalScore} pts total
              </>
            ) : (
              'Not yet ranked — no completed challenges.'
            )}
          </p>
        </div>

        {profile.data.challenges.length > 0 && (
          <div>
            <p className="section-label" style={{ marginBottom: 'var(--space-3)' }}>
              Challenges
            </p>
            <ul className="challenge-list">
              {profile.data.challenges.map((challenge) => (
                <li key={challenge.challengeId}>
                  <span className="challenge-row">
                    <span className="challenge-row-title">{challenge.title}</span>
                    <span className="challenge-row-meta">
                      <span className="badge-category">{challenge.category}</span>
                      <span className="challenge-row-points">{challenge.bestScore}/{challenge.points} pts</span>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
