'use client'

import { useResource } from '../../lib/api'

type Check = {
  name: string
  status: string
  points: number
  pointsEarned: number
}

type RunStatus = {
  runId: string
  challengeId: string
  targetUrl: string
  status: string
  score: number | null
  checks: Check[] | null
  error: string | null
  createdAt: string
  feedback: string | null
  feedbackStatus: string
  feedbackLocked: boolean
}

function isTerminal(run: RunStatus): boolean {
  if (run.status === 'pending') return false
  if (run.status === 'completed') return run.feedbackStatus !== 'pending'
  return true
}

export default function RunStatusPage({ params }: { params: { id: string } }) {
  const run = useResource<RunStatus>(`/api/runs/${params.id}`, {
    redirectOn401: true,
    pollMs: 2000,
    stopPolling: isTerminal,
  })

  if (run.loading) return <p>Loading...</p>
  if (run.notFound) return <p>Run not found.</p>
  if (run.error) return <p>Something went wrong loading this run.</p>
  if (!run.data) return null

  if (run.data.status === 'pending') {
    return <p>Running your submission...</p>
  }

  if (run.data.status === 'completed') {
    return (
      <main>
        <h1>Score: {run.data.score}</h1>
        <ul>
          {(run.data.checks ?? []).map((check) => (
            <li key={check.name}>
              {check.name}: {check.status} ({check.pointsEarned}/{check.points})
            </li>
          ))}
        </ul>
        {run.data.feedbackStatus === 'pending' && <p>Generating feedback...</p>}
        {run.data.feedbackLocked && <p>Upgrade to see feedback for this attempt.</p>}
        {run.data.feedbackStatus === 'ready' && !run.data.feedbackLocked && <p>{run.data.feedback}</p>}
      </main>
    )
  }

  if (run.data.status === 'timed_out') {
    return <p>This is taking longer than expected — check back later.</p>
  }

  return <p>{run.data.error}</p>
}
