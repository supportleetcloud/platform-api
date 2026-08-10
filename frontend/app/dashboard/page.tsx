'use client'

import { useEffect, useState } from 'react'
import { useResource, useTosGate, backendFetch } from '../lib/api'
import TopBar from '../components/TopBar'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
  tosAcceptanceRequired: boolean
  hideFromRanking: boolean
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

  const [hideFromRanking, setHideFromRanking] = useState(false)
  const [savingRanking, setSavingRanking] = useState(false)
  const [rankingError, setRankingError] = useState<string | null>(null)

  useEffect(() => {
    if (me.data) setHideFromRanking(me.data.hideFromRanking)
  }, [me.data])

  function handleToggleRanking(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.checked
    setHideFromRanking(next)
    setRankingError(null)
    setSavingRanking(true)

    backendFetch('/api/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hideFromRanking: next }),
    })
      .then((res) => {
        if (res.status === 200) {
          setSavingRanking(false)
          return
        }
        setHideFromRanking(!next)
        setRankingError('Could not save preference.')
        setSavingRanking(false)
      })
      .catch(() => {
        setHideFromRanking(!next)
        setRankingError('Could not save preference.')
        setSavingRanking(false)
      })
  }

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

        <div>
          <label className="field-checkbox">
            <input
              type="checkbox"
              checked={hideFromRanking}
              onChange={handleToggleRanking}
              disabled={savingRanking}
            />
            Hide from public ranking
          </label>
          {rankingError && <p className="form-error">{rankingError}</p>}
        </div>
      </div>
    </div>
  )
}
