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

type BillingSettings = {
  priceCents: number
  currency: string
} | null

export default function AdminBillingPage() {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const settings = useResource<BillingSettings>('/api/admin/billing-settings')

  const [price, setPrice] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (settings.data) {
      setPrice((settings.data.priceCents / 100).toFixed(2))
    }
  }, [settings.data])

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaveError(null)
    setSaved(false)
    setSaving(true)

    const amountCents = Math.round(parseFloat(price) * 100)

    backendFetch('/api/admin/billing-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 200) {
          setSaved(true)
          setSaving(false)
          return
        }
        setSaveError(body.error ?? 'Could not save price.')
        setSaving(false)
      })
      .catch(() => {
        setSaveError('Could not save price.')
        setSaving(false)
      })
  }

  if (me.loading || settings.loading) return <p className="state-message">Loading...</p>
  if (me.error) return <p className="state-message">Something went wrong loading this page.</p>
  if (!me.data) return null
  if (!me.data.isAdmin) return <p className="state-message">Not authorized.</p>
  if (settings.error) return <p className="state-message">Could not load billing settings.</p>

  return (
    <div className="page">
      <TopBar location="admin / billing" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content content-narrow">
        <div>
          <h1 className="page-title">Billing</h1>
          <p className="page-subtitle">Set the monthly subscription price.</p>
        </div>

        <form className="panel" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label" htmlFor="price">
              Monthly price (USD)
            </label>
            <input
              id="price"
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </div>

          <button type="submit" disabled={saving}>
            Save
          </button>
          {saved && <p className="form-success">Price saved.</p>}
          {saveError && <p className="form-error">{saveError}</p>}
        </form>
      </div>
    </div>
  )
}
