import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminNewChallengePage from '../app/admin/challenges/new/page'

const pushMock = vi.fn()
const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}))

const ADMIN_ME = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: true }
const NON_ADMIN_ME = { id: '2', username: 'someone', avatarUrl: null, isAdmin: false }

function mockFetch(routes: { me?: { status: number; json?: unknown }; post?: { status: number; json?: unknown } }) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/api/me')) {
      return Promise.resolve({ status: routes.me?.status ?? 200, json: async () => routes.me?.json })
    }
    return Promise.resolve({ status: routes.post?.status ?? 500, json: async () => routes.post?.json })
  }) as any
}

describe('AdminNewChallengePage', () => {
  beforeEach(() => {
    pushMock.mockReset()
  })

  it('shows "Not authorized." for a non-admin user', async () => {
    mockFetch({ me: { status: 200, json: NON_ADMIN_ME } })

    render(<AdminNewChallengePage />)

    await waitFor(() => {
      expect(screen.getByText('Not authorized.')).toBeInTheDocument()
    })
  })

  it('creates a challenge and navigates to the list on success', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, post: { status: 201, json: { challengeId: 'new-id' } } })
    const user = userEvent.setup()

    render(<AdminNewChallengePage />)
    await waitFor(() => screen.getByLabelText(/^title$/i))

    await user.type(screen.getByLabelText(/^title$/i), 'New Challenge')
    await user.type(screen.getByLabelText(/^name$/i), 'GET /ping')
    await user.clear(screen.getByLabelText(/^path$/i))
    await user.type(screen.getByLabelText(/^path$/i), '/ping')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/admin/challenges')
    })
  })
})
