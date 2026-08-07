'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useResource, backendFetch } from '../../lib/api'

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

  if (challenge.loading) return <p>Loading...</p>
  if (challenge.error) return <p>Could not load this challenge.</p>
  if (!challenge.data) return null

  return (
    <main>
      <h1>{challenge.data.title}</h1>
      <p>
        {challenge.data.category} &middot; {challenge.data.points} pts
      </p>

      <form onSubmit={handleSubmit}>
        <label>
          API URL
          <input
            value={targetUrl}
            onChange={(event) => setTargetUrl(event.target.value)}
            required
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={confirmedAuthorization}
            onChange={(event) => setConfirmedAuthorization(event.target.checked)}
          />
          I own or am authorized to test this URL
        </label>
        <button type="submit" disabled={submitting}>
          Submit
        </button>
      </form>

      {submitError && <p>{submitError}</p>}
    </main>
  )
}
