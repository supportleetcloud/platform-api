'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useResource, useTosGate, backendFetch } from '../lib/api'
import TopBar from '../components/TopBar'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
  tosAcceptanceRequired: boolean
  hideFromRanking: boolean
  isPaid: boolean
}

type Challenge = {
  id: string
  title: string
  category: string
  points: number
}

type BillingStatus = {
  isPaid: boolean
  priceCents: number | null
  currency: string | null
  cancelAtPeriodEnd: boolean
}

function CheckoutBanner() {
  const searchParams = useSearchParams()
  if (searchParams.get('checkout') !== 'success') return null
  return (
    <p className="state-message">
      Subscription activating — this can take a few seconds. Refresh if your plan doesn&apos;t update.
    </p>
  )
}

export default function DashboardPage() {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const challenges = useResource<Challenge[]>('/api/challenges')
  const billing = useResource<BillingStatus>('/api/billing/status')
  useTosGate(me)

  const [hideFromRanking, setHideFromRanking] = useState(false)
  const [savingRanking, setSavingRanking] = useState(false)
  const [rankingError, setRankingError] = useState<string | null>(null)

  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null)
  const [upgradeSaving, setUpgradeSaving] = useState(false)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [cancelSaving, setCancelSaving] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  useEffect(() => {
    if (me.data) setHideFromRanking(me.data.hideFromRanking)
  }, [me.data])

  useEffect(() => {
    if (billing.data) setBillingStatus(billing.data)
  }, [billing.data])

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

  function handleUpgrade() {
    setUpgradeError(null)
    setUpgradeSaving(true)

    backendFetch('/api/billing/checkout-session', { method: 'POST' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 200) {
          window.location.href = body.url
          return
        }
        setUpgradeError(body.error === 'not_configured' ? "Billing isn't set up yet." : 'Could not start checkout.')
        setUpgradeSaving(false)
      })
      .catch(() => {
        setUpgradeError('Could not start checkout.')
        setUpgradeSaving(false)
      })
  }

  function handleCancel() {
    setCancelError(null)
    setCancelSaving(true)

    backendFetch('/api/billing/cancel', { method: 'POST' })
      .then((res) => {
        if (res.status === 200) {
          setConfirmingCancel(false)
          setCancelSaving(false)
          setBillingStatus((prev) => (prev ? { ...prev, cancelAtPeriodEnd: true } : prev))
          return
        }
        setCancelError('Could not cancel subscription.')
        setCancelSaving(false)
      })
      .catch(() => {
        setCancelError('Could not cancel subscription.')
        setCancelSaving(false)
      })
  }

  if (me.loading) return <p className="state-message">Loading...</p>
  if (me.error) return <p className="state-message">Something went wrong loading your dashboard.</p>
  if (!me.data) return null

  const priceLabel =
    billingStatus?.priceCents != null ? `$${(billingStatus.priceCents / 100).toFixed(2)}/mo` : null

  return (
    <div className="page">
      <TopBar location="dashboard" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content">
        <div>
          <h1 className="page-title">Welcome, {me.data.username}</h1>
          <p className="page-subtitle">Pick a challenge, submit your API&apos;s URL, watch the checks run.</p>
        </div>

        <Suspense fallback={null}>
          <CheckoutBanner />
        </Suspense>

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
          <p className="section-label" style={{ marginBottom: 'var(--space-3)' }}>
            Billing
          </p>
          {billing.loading && <p className="muted">Loading billing status...</p>}
          {billing.error && <p className="form-error">Could not load billing status.</p>}
          {billingStatus && !billingStatus.isPaid && (
            <div>
              <p>Free plan{priceLabel ? ` — ${priceLabel} unlocks the full catalog and unlimited attempts.` : '.'}</p>
              <button onClick={handleUpgrade} disabled={upgradeSaving}>
                Upgrade
              </button>
              {upgradeError && <p className="form-error">{upgradeError}</p>}
            </div>
          )}
          {billingStatus && billingStatus.isPaid && !billingStatus.cancelAtPeriodEnd && (
            <div>
              <p>Pro plan — active</p>
              {!confirmingCancel && (
                <button onClick={() => setConfirmingCancel(true)}>Cancel subscription</button>
              )}
              {confirmingCancel && (
                <div>
                  <p>Are you sure?</p>
                  <button onClick={handleCancel} disabled={cancelSaving}>
                    Confirm cancel
                  </button>
                  <button onClick={() => setConfirmingCancel(false)}>Never mind</button>
                </div>
              )}
              {cancelError && <p className="form-error">{cancelError}</p>}
            </div>
          )}
          {billingStatus && billingStatus.isPaid && billingStatus.cancelAtPeriodEnd && (
            <p>Pro plan — cancels at the end of the current billing period.</p>
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
