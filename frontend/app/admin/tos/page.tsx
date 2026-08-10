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

type TosVersionRow = {
  id: string
  content: string
  publishedAt: string
}

export default function AdminTosPage() {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const versions = useResource<TosVersionRow[]>('/api/admin/tos/versions')

  const [list, setList] = useState<TosVersionRow[] | null>(null)
  const [content, setContent] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)

  useEffect(() => {
    if (versions.data) setList(versions.data)
  }, [versions.data])

  function handlePublish(event: React.FormEvent) {
    event.preventDefault()
    setPublishError(null)
    setPublishing(true)

    backendFetch('/api/admin/tos/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 201) {
          setList((prev) => [body, ...(prev ?? [])])
          setContent('')
          setPublishing(false)
          return
        }
        setPublishError(body.error ?? 'Could not publish new version.')
        setPublishing(false)
      })
      .catch(() => {
        setPublishError('Could not publish new version.')
        setPublishing(false)
      })
  }

  if (me.loading || versions.loading) return <p className="state-message">Loading...</p>
  if (me.error) return <p className="state-message">Something went wrong loading this page.</p>
  if (!me.data) return null
  if (!me.data.isAdmin) return <p className="state-message">Not authorized.</p>
  if (versions.error) return <p className="state-message">Could not load ToS history.</p>
  if (!list) return null

  return (
    <div className="page">
      <TopBar location="admin/tos" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content content-narrow">
        <h1 className="page-title">Terms of Use</h1>

        <form className="panel" onSubmit={handlePublish}>
          <div className="field">
            <label className="field-label" htmlFor="content">
              New version content
            </label>
            <textarea
              id="content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={8}
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={publishing}>
            {publishing ? 'Publishing…' : 'Publish new version'}
          </button>
          {publishError && <p className="form-error">{publishError}</p>}
        </form>

        <div>
          <p className="section-label" style={{ marginBottom: 'var(--space-3)' }}>
            History
          </p>
          <ul className="challenge-list">
            {list.map((version, index) => (
              <li key={version.id} className="challenge-row">
                <span className="challenge-row-title">{index === 0 ? 'Current' : new Date(version.publishedAt).toLocaleDateString()}</span>
                <span className="challenge-row-meta">{version.content}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
