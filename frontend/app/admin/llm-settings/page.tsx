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

type LlmSettings = {
  provider: string | null
  model: string | null
  baseUrl: string | null
  apiKeySet: boolean
}

export default function AdminLlmSettingsPage() {
  const me = useResource<Me>('/api/me', { redirectOn401: true })
  const settings = useResource<LlmSettings>('/api/admin/llm-settings')

  const [provider, setProvider] = useState('claude')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (settings.data) {
      setProvider(settings.data.provider ?? 'claude')
      setModel(settings.data.model ?? '')
      setBaseUrl(settings.data.baseUrl ?? '')
    }
  }, [settings.data])

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaveError(null)
    setSaved(false)
    setSaving(true)

    backendFetch('/api/admin/llm-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        model,
        baseUrl: provider === 'ollama' ? baseUrl : undefined,
        apiKey: apiKey.trim().length > 0 ? apiKey : undefined,
      }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.status === 200) {
          setSaved(true)
          setApiKey('')
          setSaving(false)
          return
        }
        setSaveError(body.error ?? 'Could not save settings.')
        setSaving(false)
      })
      .catch(() => {
        setSaveError('Could not save settings.')
        setSaving(false)
      })
  }

  if (me.loading || settings.loading) return <p className="state-message">Loading...</p>
  if (me.error) return <p className="state-message">Something went wrong loading this page.</p>
  if (!me.data) return null
  if (!me.data.isAdmin) return <p className="state-message">Not authorized.</p>
  if (settings.error) return <p className="state-message">Could not load LLM settings.</p>
  if (!settings.data) return null

  return (
    <div className="page">
      <TopBar location="admin / llm-settings" username={me.data.username} isAdmin={me.data.isAdmin} />
      <div className="content content-narrow">
        <div>
          <h1 className="page-title">LLM settings</h1>
          <p className="page-subtitle">Choose which provider generates feedback for completed runs.</p>
        </div>

        <form className="panel" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label" htmlFor="provider">
              Provider
            </label>
            <select id="provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="claude">Claude</option>
              <option value="openai">OpenAI</option>
              <option value="openrouter">OpenRouter</option>
              <option value="ollama">Ollama</option>
            </select>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="model">
              Model
            </label>
            <input
              id="model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={provider === 'openrouter' ? 'anthropic/claude-3.5-sonnet' : 'claude-sonnet-5'}
            />
          </div>

          {provider === 'ollama' && (
            <div className="field">
              <label className="field-label" htmlFor="baseUrl">
                Base URL
              </label>
              <input
                id="baseUrl"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="http://localhost:11434"
              />
            </div>
          )}

          {provider !== 'ollama' && (
            <div className="field">
              <label className="field-label" htmlFor="apiKey">
                API key{settings.data.apiKeySet ? ' (leave blank to keep current key)' : ''}
              </label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
          )}

          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>

          {saveError && <p className="form-error">{saveError}</p>}
          {saved && <p className="form-success">Settings saved.</p>}
        </form>
      </div>
    </div>
  )
}
