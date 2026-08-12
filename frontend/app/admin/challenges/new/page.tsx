'use client'

import { useRouter } from 'next/navigation'
import { useResource, backendFetch } from '../../../lib/api'
import TopBar from '../../../components/TopBar'
import ChallengeForm, { ChallengeInput } from '../ChallengeForm'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
}

export default function AdminNewChallengePage() {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const router = useRouter()

  function handleSave(input: ChallengeInput): Promise<{ ok: true } | { ok: false; error: string }> {
    return backendFetch('/api/admin/challenges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 201) {
          router.push('/admin/challenges')
          return { ok: true as const }
        }
        return { ok: false as const, error: body.error ?? 'Could not create challenge.' }
      })
      .catch(() => ({ ok: false as const, error: 'Could not create challenge.' }))
  }

  if (me.loading) return <p className="state-message">Loading...</p>
  if (me.error) return <p className="state-message">Something went wrong loading this page.</p>
  if (!me.data) return null
  if (!me.data.isAdmin) return <p className="state-message">Not authorized.</p>

  return (
    <div className="page">
      <TopBar location="admin / challenges / new" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content content-narrow">
        <div>
          <h1 className="page-title">New Challenge</h1>
        </div>
        <ChallengeForm onSave={handleSave} />
      </div>
    </div>
  )
}
