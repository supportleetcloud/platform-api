import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminEditChallengePage from '../app/admin/challenges/[id]/edit/page'

const pushMock = vi.fn()
const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}))

const ADMIN_ME = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: true }
const DETAIL = {
  id: 'existing-id',
  title: 'Existing Challenge',
  description: 'A description',
  objective: undefined,
  technicalDetails: undefined,
  category: 'crud',
  archived: false,
  source: 'database',
  checks: [{ name: 'GET /ping', method: 'GET', path: '/ping', expectStatus: 200, points: 10 }],
}

function mockFetch(routes: {
  me?: { status: number; json?: unknown }
  get?: { status: number; json?: unknown }
  put?: { status: number; json?: unknown }
}) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const isMe = url.includes('/api/me')
    const isPut = init?.method === 'PUT'
    const route = isMe ? routes.me : isPut ? routes.put : routes.get
    return Promise.resolve({ status: route?.status ?? 500, json: async () => route?.json })
  }) as any
}

describe('AdminEditChallengePage', () => {
  beforeEach(() => {
    pushMock.mockReset()
  })

  it('pre-fills the form from the fetched detail', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: DETAIL } })

    render(<AdminEditChallengePage params={{ id: 'existing-id' }} />)

    await waitFor(() => {
      expect(screen.getByDisplayValue('Existing Challenge')).toBeInTheDocument()
    })
    expect(screen.getByDisplayValue('GET /ping')).toBeInTheDocument()
  })

  it('shows a read-only message for a file-defined challenge instead of the form', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: { ...DETAIL, source: 'file' } } })

    render(<AdminEditChallengePage params={{ id: 'existing-id' }} />)

    await waitFor(() => {
      expect(screen.getByText(/defined in a yaml file/i)).toBeInTheDocument()
    })
    expect(screen.queryByDisplayValue('Existing Challenge')).not.toBeInTheDocument()
  })

  it('saves and navigates to the list on success', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: DETAIL },
      put: { status: 200, json: { challengeId: 'existing-id' } },
    })
    const user = userEvent.setup()

    render(<AdminEditChallengePage params={{ id: 'existing-id' }} />)
    await waitFor(() => screen.getByDisplayValue('Existing Challenge'))

    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/admin/challenges')
    })
  })
})
