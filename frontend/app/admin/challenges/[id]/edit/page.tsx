'use client'

import { useRouter } from 'next/navigation'
import { useResource, backendFetch } from '../../../../lib/api'
import TopBar from '../../../../components/TopBar'
import ChallengeForm, { ChallengeInput, ChallengeFormValues } from '../../ChallengeForm'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
}

type AdminChallengeDetail = {
  id: string
  title: string
  description?: string
  objective?: string
  technicalDetails?: string
  category: string
  archived: boolean
  source: 'file' | 'database'
  checks: {
    name: string
    method: string
    path: string
    requestHeaders?: Record<string, string>
    requestBody?: unknown
    expectStatus: number
    expectJson?: unknown
    expectHeaders?: Record<string, string>
    points: number
  }[]
}

function toFormValues(detail: AdminChallengeDetail): ChallengeFormValues {
  return {
    title: detail.title,
    description: detail.description ?? '',
    objective: detail.objective ?? '',
    technicalDetails: detail.technicalDetails ?? '',
    category: detail.category,
    checks: detail.checks.map((check) => ({
      name: check.name,
      method: check.method,
      path: check.path,
      requestHeaders: check.requestHeaders ? JSON.stringify(check.requestHeaders) : '',
      requestBody: check.requestBody !== undefined ? JSON.stringify(check.requestBody) : '',
      expectStatus: String(check.expectStatus),
      expectJson: check.expectJson !== undefined ? JSON.stringify(check.expectJson) : '',
      expectHeaders: check.expectHeaders ? JSON.stringify(check.expectHeaders) : '',
      points: String(check.points),
    })),
  }
}

export default function AdminEditChallengePage({ params }: { params: { id: string } }) {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const detail = useResource<AdminChallengeDetail>(`/api/admin/challenges/${params.id}`)
  const router = useRouter()

  function handleSave(input: ChallengeInput): Promise<{ ok: true } | { ok: false; error: string }> {
    return backendFetch(`/api/admin/challenges/${params.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 200) {
          router.push('/admin/challenges')
          return { ok: true as const }
        }
        return { ok: false as const, error: body.error ?? 'Could not save challenge.' }
      })
      .catch(() => ({ ok: false as const, error: 'Could not save challenge.' }))
  }

  if (me.loading || detail.loading) return <p className="state-message">Loading...</p>
  if (me.error || detail.error) return <p className="state-message">Something went wrong loading this page.</p>
  if (!me.data) return null
  if (!me.data.isAdmin) return <p className="state-message">Not authorized.</p>
  if (detail.notFound) return <p className="state-message">Challenge not found.</p>
  if (!detail.data) return null

  return (
    <div className="page">
      <TopBar location="admin / challenges / edit" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content content-narrow">
        <div>
          <h1 className="page-title">Edit Challenge</h1>
        </div>
        {detail.data.source === 'file' ? (
          <p className="state-message">This challenge is defined in a YAML file and can&apos;t be edited here.</p>
        ) : (
          <ChallengeForm initial={toFormValues(detail.data)} onSave={handleSave} />
        )}
      </div>
    </div>
  )
}
