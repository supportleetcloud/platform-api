import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminLlmSettingsPage from '../app/admin/llm-settings/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}))

const ADMIN_ME = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: true }
const NON_ADMIN_ME = { id: '2', username: 'someone', avatarUrl: null, isAdmin: false }
const SETTINGS = { provider: 'claude', model: 'claude-sonnet-5', baseUrl: null, apiKeySet: true }

function mockFetch(routes: {
  me?: { status: number; json?: unknown }
  get?: { status: number; json?: unknown }
  put?: { status: number; json?: unknown }
  models?: { status: number; json?: unknown }
}) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const isMe = url.includes('/api/me')
    const isModels = url.includes('/ollama-models')
    const isPut = init?.method === 'PUT'
    const route = isMe ? routes.me : isModels ? routes.models : isPut ? routes.put : routes.get
    const status = route?.status ?? 500
    return Promise.resolve({ status, json: async () => route?.json })
  }) as any
}

describe('AdminLlmSettingsPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
  })

  it('shows "Not authorized." for a non-admin user', async () => {
    mockFetch({ me: { status: 200, json: NON_ADMIN_ME }, get: { status: 200, json: SETTINGS } })

    render(<AdminLlmSettingsPage />)

    await waitFor(() => {
      expect(screen.getByText('Not authorized.')).toBeInTheDocument()
    })
  })

  it('renders the form pre-filled with existing settings for an admin', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: SETTINGS } })

    render(<AdminLlmSettingsPage />)

    await waitFor(() => {
      expect(screen.getByDisplayValue('claude-sonnet-5')).toBeInTheDocument()
    })
    expect(screen.getByText(/leave blank to keep current key/i)).toBeInTheDocument()
  })

  it('shows the base URL field only when provider is ollama', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: SETTINGS } })
    const user = userEvent.setup()

    render(<AdminLlmSettingsPage />)
    await waitFor(() => screen.getByDisplayValue('claude-sonnet-5'))

    expect(screen.queryByLabelText(/base url/i)).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText(/provider/i), 'ollama')

    expect(screen.getByLabelText(/base url/i)).toBeInTheDocument()
  })

  it('keeps the model field as a plain text input when switching to ollama with an empty base URL', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: SETTINGS } })
    const user = userEvent.setup()

    render(<AdminLlmSettingsPage />)
    await waitFor(() => screen.getByDisplayValue('claude-sonnet-5'))

    await user.selectOptions(screen.getByLabelText(/provider/i), 'ollama')

    expect(screen.getByLabelText(/^model$/i).tagName).toBe('INPUT')
  })

  it('saves successfully and shows a confirmation', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: SETTINGS },
      put: { status: 200, json: { ...SETTINGS, model: 'claude-opus-5' } },
    })
    const user = userEvent.setup()

    render(<AdminLlmSettingsPage />)
    await waitFor(() => screen.getByDisplayValue('claude-sonnet-5'))

    await user.clear(screen.getByLabelText(/model/i))
    await user.type(screen.getByLabelText(/model/i), 'claude-opus-5')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(screen.getByText('Settings saved.')).toBeInTheDocument()
    })
  })

  it('shows the server error message on a validation failure', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: SETTINGS },
      put: { status: 400, json: { error: 'model is required' } },
    })
    const user = userEvent.setup()

    render(<AdminLlmSettingsPage />)
    await waitFor(() => screen.getByDisplayValue('claude-sonnet-5'))

    await user.clear(screen.getByLabelText(/model/i))
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(screen.getByText('model is required')).toBeInTheDocument()
    })
  })

  it('renders a model dropdown populated with fetched models when the saved provider is ollama', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: {
        status: 200,
        json: { provider: 'ollama', model: 'llama3:latest', baseUrl: 'http://localhost:11434', apiKeySet: false },
      },
      models: { status: 200, json: { models: ['llama3:latest', 'mistral:latest'] } },
    })

    render(<AdminLlmSettingsPage />)

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'mistral:latest' })).toBeInTheDocument()
    })
    expect(screen.getByLabelText(/^model$/i).tagName).toBe('SELECT')
    expect(screen.getByDisplayValue('llama3:latest')).toBeInTheDocument()
  })

  it('fetches models when the base URL is edited and blurred while provider is ollama', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: SETTINGS },
      models: { status: 200, json: { models: ['llama3:latest'] } },
    })
    const user = userEvent.setup()

    render(<AdminLlmSettingsPage />)
    await waitFor(() => screen.getByDisplayValue('claude-sonnet-5'))

    await user.selectOptions(screen.getByLabelText(/provider/i), 'ollama')
    await user.type(screen.getByLabelText(/base url/i), 'http://localhost:11434')
    await user.tab()

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'llama3:latest' })).toBeInTheDocument()
    })
  })

  it('reconciles the saved model to the first fetched model when the saved model is not in the fetched list, so Save persists the shown model', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: {
        status: 200,
        json: { provider: 'ollama', model: 'llama3', baseUrl: 'http://localhost:11434', apiKeySet: false },
      },
      models: { status: 200, json: { models: ['mistral:latest', 'qwen:7b'] } },
      put: {
        status: 200,
        json: { provider: 'ollama', model: 'mistral:latest', baseUrl: 'http://localhost:11434', apiKeySet: false },
      },
    })
    const user = userEvent.setup()

    render(<AdminLlmSettingsPage />)

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'qwen:7b' })).toBeInTheDocument()
    })
    expect(screen.getByDisplayValue('mistral:latest')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(screen.getByText('Settings saved.')).toBeInTheDocument()
    })

    const putCall = (global.fetch as any).mock.calls.find((call: any) => call[1]?.method === 'PUT')
    const body = JSON.parse(putCall[1].body)
    expect(body.model).toBe('mistral:latest')
  })

  it('falls back to a text input and shows an error when the ollama models fetch fails', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: {
        status: 200,
        json: { provider: 'ollama', model: 'llama3:latest', baseUrl: 'http://localhost:11434', apiKeySet: false },
      },
      models: { status: 502, json: { error: 'could not reach ollama' } },
    })

    render(<AdminLlmSettingsPage />)

    await waitFor(() => {
      expect(screen.getByText('Could not load Ollama models.')).toBeInTheDocument()
    })
    expect(screen.getByLabelText(/^model$/i).tagName).toBe('INPUT')
    expect(screen.getByDisplayValue('llama3:latest')).toBeInTheDocument()
  })
})
