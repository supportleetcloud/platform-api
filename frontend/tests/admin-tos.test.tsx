import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminTosPage from '../app/admin/tos/page'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

const ADMIN_ME = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: true }
const NON_ADMIN_ME = { id: '2', username: 'someone', avatarUrl: null, isAdmin: false }
const VERSIONS = [
  { id: 'v2', content: 'Version two.', publishedAt: '2026-02-01T00:00:00.000Z' },
  { id: 'v1', content: 'Version one.', publishedAt: '2026-01-01T00:00:00.000Z' },
]

function mockFetch(routes: {
  me?: { status: number; json?: unknown }
  get?: { status: number; json?: unknown }
  post?: { status: number; json?: unknown }
}) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/api/me')) return Promise.resolve({ status: routes.me?.status ?? 500, json: async () => routes.me?.json })
    const route = init?.method === 'POST' ? routes.post : routes.get
    return Promise.resolve({ status: route?.status ?? 500, json: async () => route?.json })
  }) as any
}

describe('AdminTosPage', () => {
  beforeEach(() => {})

  it('shows "Not authorized." for a non-admin user', async () => {
    mockFetch({ me: { status: 200, json: NON_ADMIN_ME }, get: { status: 200, json: VERSIONS } })

    render(<AdminTosPage />)

    await waitFor(() => {
      expect(screen.getByText('Not authorized.')).toBeInTheDocument()
    })
  })

  it('lists published versions, newest marked current', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: VERSIONS } })

    render(<AdminTosPage />)

    await waitFor(() => {
      expect(screen.getByText('Version two.')).toBeInTheDocument()
    })
    expect(screen.getByText('Version one.')).toBeInTheDocument()
    expect(screen.getByText('Current')).toBeInTheDocument()
  })

  it('publishes a new version and clears the textarea', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: [] },
      post: { status: 201, json: { id: 'v3', content: 'Version three.', publishedAt: '2026-03-01T00:00:00.000Z' } },
    })
    const user = userEvent.setup()

    render(<AdminTosPage />)
    await waitFor(() => screen.getByLabelText(/new version content/i))

    await user.type(screen.getByLabelText(/new version content/i), 'Version three.')
    await user.click(screen.getByRole('button', { name: /publish/i }))

    await waitFor(() => {
      expect(screen.getByText('Version three.')).toBeInTheDocument()
    })
    expect(screen.getByLabelText(/new version content/i)).toHaveValue('')
  })

  it('shows the server error message on a publish failure', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: [] },
      post: { status: 400, json: { error: 'content is required' } },
    })
    const user = userEvent.setup()

    render(<AdminTosPage />)
    await waitFor(() => screen.getByLabelText(/new version content/i))

    await user.click(screen.getByRole('button', { name: /publish/i }))

    await waitFor(() => {
      expect(screen.getByText('content is required')).toBeInTheDocument()
    })
  })
})
