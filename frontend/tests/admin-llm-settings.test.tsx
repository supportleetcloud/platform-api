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
}) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const isMe = url.includes('/api/me')
    const isPut = init?.method === 'PUT'
    const route = isMe ? routes.me : isPut ? routes.put : routes.get
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
})
