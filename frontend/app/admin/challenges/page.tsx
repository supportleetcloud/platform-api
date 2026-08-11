'use client'

import { useEffect, useState } from 'react'
import { useResource, backendFetch } from '../../lib/api'
import TopBar from '../../components/TopBar'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
}

type AdminChallengeListItem = {
  id: string
  title: string
  category: string
  points: number
  archived: boolean
  source: 'file' | 'database'
}

export default function AdminChallengesListPage() {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const challenges = useResource<AdminChallengeListItem[]>('/api/admin/challenges')

  const [items, setItems] = useState<AdminChallengeListItem[] | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  useEffect(() => {
    if (challenges.data) setItems(challenges.data)
  }, [challenges.data])

  function handleToggleArchive(id: string, nextArchived: boolean) {
    setArchiveError(null)
    backendFetch(`/api/admin/challenges/${id}/archive`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: nextArchived }),
    })
      .then((res) => {
        if (res.status === 200) {
          setItems((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, archived: nextArchived } : c)) : prev))
          return
        }
        setArchiveError('Could not update challenge.')
      })
      .catch(() => {
        setArchiveError('Could not update challenge.')
      })
  }

  if (me.loading || challenges.loading) return <p className="state-message">Loading...</p>
  if (me.error) return <p className="state-message">Something went wrong loading this page.</p>
  if (!me.data) return null
  if (!me.data.isAdmin) return <p className="state-message">Not authorized.</p>
  if (challenges.error) return <p className="state-message">Could not load challenges.</p>
  if (!items) return null

  return (
    <div className="page">
      <TopBar location="admin / challenges" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content">
        <div>
          <h1 className="page-title">Challenges</h1>
          <p className="page-subtitle">Create and manage challenges.</p>
        </div>

        <a className="btn btn-primary" href="/admin/challenges/new">
          New Challenge
        </a>

        {archiveError && <p className="form-error">{archiveError}</p>}

        <ul className="challenge-list">
          {items.map((challenge) => (
            <li key={challenge.id} className="challenge-row">
              <span className="challenge-row-title">
                {challenge.title}
                {challenge.archived && <span className="badge-category">archived</span>}
              </span>
              <span className="challenge-row-meta">
                <span className="badge-category">{challenge.category}</span>
                <span className="challenge-row-points">{challenge.points} pts</span>
                {challenge.source === 'database' ? (
                  <a href={`/admin/challenges/${challenge.id}/edit`}>Edit</a>
                ) : (
                  <span>file-defined</span>
                )}
                <button type="button" onClick={() => handleToggleArchive(challenge.id, !challenge.archived)}>
                  {challenge.archived ? 'Unarchive' : 'Archive'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
