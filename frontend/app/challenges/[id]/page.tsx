'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useResource, backendFetch } from '../../lib/api'
import TopBar from '../../components/TopBar'

type ChallengeDetail = {
  id: string
  title: string
  category: string
  points: number
}

export default function ChallengeDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const challenge = useResource<ChallengeDetail>(`/api/challenges/${params.id}`)
  const [targetUrl, setTargetUrl] = useState('')
  const [confirmedAuthorization, setConfirmedAuthorization] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitError(null)
    setSubmitting(true)

    backendFetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: params.id, targetUrl, confirmedAuthorization }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 202) {
          router.push(`/runs/${body.runId}`)
          return
        }
        if (res.status === 400 || res.status === 403) {
          setSubmitError(body.error ?? 'Submission was rejected.')
          setSubmitting(false)
          return
        }
        setSubmitError('Something went wrong submitting your run.')
        setSubmitting(false)
      })
      .catch(() => {
        setSubmitError('Something went wrong submitting your run.')
        setSubmitting(false)
      })
  }

  if (challenge.loading) return <p className="state-message">Loading...</p>
  if (challenge.notFound) return <p className="state-message">Challenge not found.</p>
  if (challenge.error) return <p className="state-message">Could not load this challenge.</p>
  if (!challenge.data) return null

  return (
    <div className="page">
      <TopBar location={params.id} />
      <div className="content content-narrow">
        <div>
          <h1 className="page-title">{challenge.data.title}</h1>
          <p className="page-subtitle">
            <span className="badge-category">{challenge.data.category}</span> {challenge.data.points} pts
          </p>
        </div>

        <form className="panel" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label" htmlFor="targetUrl">
              API URL
            </label>
            <input
              id="targetUrl"
              value={targetUrl}
              onChange={(event) => setTargetUrl(event.target.value)}
              placeholder="https://your-api.onrender.com"
              required
            />
          </div>
          <label className="field-checkbox">
            <input
              type="checkbox"
              checked={confirmedAuthorization}
              onChange={(event) => setConfirmedAuthorization(event.target.checked)}
            />
            I own or am authorized to test this URL
          </label>
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
          {submitError && <p className="form-error">{submitError}</p>}
        </form>
      </div>
    </div>
  )
}
