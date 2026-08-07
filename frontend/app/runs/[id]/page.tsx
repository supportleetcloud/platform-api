'use client'

import { useResource } from '../../lib/api'
import TopBar from '../../components/TopBar'
import MethodBadge from '../../components/MethodBadge'
import StatusPill from '../../components/StatusPill'

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

const METHOD_PATTERN = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)\s*(.*)$/

function parseCheckName(name: string): { method: string | null; route: string | null; description: string } {
  const match = name.match(METHOD_PATTERN)
  if (!match) {
    return { method: null, route: null, description: name }
  }
  return { method: match[1], route: match[2], description: match[3] || name }
}

export default function RunStatusPage({ params }: { params: { id: string } }) {
  const run = useResource<RunStatus>(`/api/runs/${params.id}`, {
    redirectOn401: true,
    pollMs: 2000,
    stopPolling: isTerminal,
  })

  if (run.loading) return <p className="state-message">Loading...</p>
  if (run.notFound) return <p className="state-message">Run not found.</p>
  if (run.error) return <p className="state-message">Something went wrong loading this run.</p>
  if (!run.data) return null

  const standaloneStatusStyle = { maxWidth: 480, margin: '48px auto 0', padding: '24px' }

  if (run.data.status === 'pending') {
    return (
      <p className="status-block status-block-pending" style={standaloneStatusStyle}>
        Running your submission...
      </p>
    )
  }

  if (run.data.status === 'timed_out') {
    return (
      <p className="status-block status-block-pending" style={standaloneStatusStyle}>
        This is taking longer than expected — check back later.
      </p>
    )
  }

  if (run.data.status === 'completed') {
    return (
      <div className="page">
        <TopBar location="run" />
        <div className="content content-narrow">
          <h1 className="score-header">Score: {run.data.score}</h1>

          <ul className="check-list">
            {(run.data.checks ?? []).map((check) => {
              const parsed = parseCheckName(check.name)
              return (
                <li className="check-row" key={check.name}>
                  {parsed.method && <MethodBadge method={parsed.method} />}
                  {parsed.route && <code className="check-route">{parsed.route}</code>}
                  <span className="check-desc">{parsed.description}</span>
                  <span className="check-points">
                    {check.pointsEarned}/{check.points}
                  </span>
                  <StatusPill status={check.status} />
                </li>
              )
            })}
          </ul>

          {run.data.feedbackStatus === 'pending' && (
            <p className="status-block status-block-pending">Generating feedback...</p>
          )}
          {run.data.feedbackLocked && <p className="feedback-block">Upgrade to see feedback for this attempt.</p>}
          {run.data.feedbackStatus === 'ready' && !run.data.feedbackLocked && (
            <div className="feedback-block">
              <p className="section-label" style={{ marginBottom: 'var(--space-2)' }}>
                Feedback
              </p>
              <p className="feedback-text">{run.data.feedback}</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <p className="status-block status-block-error" style={standaloneStatusStyle}>
      {run.data.error}
    </p>
  )
}
