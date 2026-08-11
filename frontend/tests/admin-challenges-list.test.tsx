import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminChallengesListPage from '../app/admin/challenges/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}))

const ADMIN_ME = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: true }
const NON_ADMIN_ME = { id: '2', username: 'someone', avatarUrl: null, isAdmin: false }
const CHALLENGES = [
  { id: 'db-challenge-1', title: 'DB Challenge', category: 'crud', points: 20, archived: false, source: 'database' },
  { id: 'file-challenge-1', title: 'File Challenge', category: 'auth', points: 15, archived: false, source: 'file' },
]

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

describe('AdminChallengesListPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
  })

  it('shows "Not authorized." for a non-admin user', async () => {
    mockFetch({ me: { status: 200, json: NON_ADMIN_ME }, get: { status: 200, json: CHALLENGES } })

    render(<AdminChallengesListPage />)

    await waitFor(() => {
      expect(screen.getByText('Not authorized.')).toBeInTheDocument()
    })
  })

  it('lists challenges with an Edit link only for database-sourced ones', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: CHALLENGES } })

    render(<AdminChallengesListPage />)

    await waitFor(() => {
      expect(screen.getByText('DB Challenge')).toBeInTheDocument()
    })
    expect(screen.getByText('File Challenge')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /edit/i })).toHaveAttribute('href', '/admin/challenges/db-challenge-1/edit')
  })

  it('renders a "New Challenge" link to /admin/challenges/new', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: CHALLENGES } })

    render(<AdminChallengesListPage />)

    await waitFor(() => screen.getByText('DB Challenge'))
    expect(screen.getByRole('link', { name: /new challenge/i })).toHaveAttribute('href', '/admin/challenges/new')
  })

  it('archives a challenge and reflects the new state', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: CHALLENGES },
      put: { status: 200, json: { archived: true } },
    })
    const user = userEvent.setup()

    render(<AdminChallengesListPage />)
    await waitFor(() => screen.getByText('DB Challenge'))

    await user.click(screen.getAllByRole('button', { name: /archive/i })[0])

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /unarchive/i })[0]).toBeInTheDocument()
    })
  })
})
