'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useResource, backendFetch } from '../lib/api'
import TopBar from '../components/TopBar'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
  tosAcceptanceRequired: boolean
}

type TosCurrent = {
  id: string
  content: string
  publishedAt: string
}

export default function AcceptTermsPage() {
  const router = useRouter()
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const [reloadKey, setReloadKey] = useState(0)
  const tos = useResource<TosCurrent>(`/api/tos/current?r=${reloadKey}`)

  const [accepted, setAccepted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (me.data && !me.data.tosAcceptanceRequired) {
      router.replace('/dashboard')
    }
  }, [me.data, router])

  useEffect(() => {
    if (tos.notFound) {
      router.replace('/dashboard')
    }
  }, [tos.notFound, router])

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!tos.data) return
    setSubmitError(null)
    setSubmitting(true)

    backendFetch('/api/tos/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tosVersionId: tos.data.id }),
    })
      .then(async (res) => {
        if (res.status === 200) {
          router.replace('/dashboard')
          return
        }
        if (res.status === 409) {
          setSubmitError('The terms were updated — please review the new version.')
          setAccepted(false)
          setSubmitting(false)
          setReloadKey((k) => k + 1)
          return
        }
        setSubmitError('Something went wrong recording your acceptance.')
        setSubmitting(false)
      })
      .catch(() => {
        setSubmitError('Something went wrong recording your acceptance.')
        setSubmitting(false)
      })
  }

  if (me.loading || tos.loading) return <p className="state-message">Loading...</p>
  if (me.error || tos.error) return <p className="state-message">Something went wrong loading the terms.</p>
  if (!me.data || !tos.data) return null

  return (
    <div className="page">
      <TopBar />
      <div className="content content-narrow">
        <h1 className="page-title">Terms of Use</h1>
        <form className="panel" onSubmit={handleSubmit}>
          <p className="feedback-text" style={{ whiteSpace: 'pre-wrap' }}>
            {tos.data.content}
          </p>
          <label className="field-checkbox">
            <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
            I have read and accept the Terms of Use
          </label>
          <button className="btn btn-primary" type="submit" disabled={!accepted || submitting}>
            {submitting ? 'Submitting…' : 'Continue'}
          </button>
          {submitError && <p className="form-error">{submitError}</p>}
        </form>
      </div>
    </div>
  )
}
