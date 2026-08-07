'use client'

import { useEffect, useState } from 'react'
import { useResource, backendFetch } from '../../lib/api'

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

  if (me.loading || settings.loading) return <p>Loading...</p>
  if (me.error) return <p>Something went wrong loading this page.</p>
  if (!me.data) return null
  if (!me.data.isAdmin) return <p>Not authorized.</p>
  if (settings.error) return <p>Could not load LLM settings.</p>
  if (!settings.data) return null

  return (
    <main>
      <h1>LLM Settings</h1>
      <form onSubmit={handleSubmit}>
        <label>
          Provider
          <select value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="claude">Claude</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="ollama">Ollama</option>
          </select>
        </label>
        <label>
          Model
          <input value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
        {provider === 'ollama' && (
          <label>
            Base URL
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
        )}
        {provider !== 'ollama' && (
          <label>
            API Key {settings.data.apiKeySet ? '(leave blank to keep current key)' : ''}
            <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </label>
        )}
        <button type="submit" disabled={saving}>
          Save
        </button>
      </form>
      {saveError && <p>{saveError}</p>}
      {saved && <p>Settings saved.</p>}
    </main>
  )
}
