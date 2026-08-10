import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import ChallengeDetailPage from '../app/challenges/[id]/page'

const pushMock = vi.fn()
const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}))

const CHALLENGE = { id: 'todo-api-crud', title: 'Build a Todo CRUD API', category: 'crud', points: 25 }
const ME = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: false, tosAcceptanceRequired: false }

function mockFetch(routes: {
  me?: { status: number; json?: unknown }
  get?: { status: number; json?: unknown }
  post?: { status: number; json?: unknown }
}) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/api/me')) {
      return Promise.resolve({ status: routes.me?.status ?? 200, json: async () => routes.me?.json ?? ME })
    }
    const route = init?.method === 'POST' ? routes.post : routes.get
    const status = route?.status ?? 500
    return Promise.resolve({ status, json: async () => route?.json })
  }) as any
}

describe('ChallengeDetailPage', () => {
  beforeEach(() => {
    pushMock.mockReset()
    replaceMock.mockReset()
  })

  it('renders the challenge title and points', async () => {
    mockFetch({ get: { status: 200, json: CHALLENGE } })

    render(<ChallengeDetailPage params={{ id: 'todo-api-crud' }} />)

    await waitFor(() => {
      expect(screen.getByText('Build a Todo CRUD API')).toBeInTheDocument()
    })
    expect(screen.getByText(/25 pts/)).toBeInTheDocument()
  })

  it('shows "Challenge not found" for a 404', async () => {
    mockFetch({ get: { status: 404, json: { error: 'challenge_not_found' } } })

    render(<ChallengeDetailPage params={{ id: 'does-not-exist' }} />)

    await waitFor(() => {
      expect(screen.getByText('Challenge not found.')).toBeInTheDocument()
    })
  })

  it('submits and navigates to the run status page on success', async () => {
    mockFetch({
      get: { status: 200, json: CHALLENGE },
      post: { status: 202, json: { runId: 'run-123', status: 'pending' } },
    })
    const user = userEvent.setup()

    render(<ChallengeDetailPage params={{ id: 'todo-api-crud' }} />)
    await waitFor(() => screen.getByText('Build a Todo CRUD API'))

    await user.type(screen.getByLabelText(/api url/i), 'https://candidate.example.com')
    await user.click(screen.getByLabelText(/authorized to test/i))
    await user.click(screen.getByRole('button', { name: /submit/i }))

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/runs/run-123')
    })
  })

  it('shows the server error message on a 400', async () => {
    mockFetch({
      get: { status: 200, json: CHALLENGE },
      post: { status: 400, json: { error: 'targetUrl must be a valid http(s) URL' } },
    })
    const user = userEvent.setup()

    render(<ChallengeDetailPage params={{ id: 'todo-api-crud' }} />)
    await waitFor(() => screen.getByText('Build a Todo CRUD API'))

    await user.type(screen.getByLabelText(/api url/i), 'not-a-url')
    await user.click(screen.getByLabelText(/authorized to test/i))
    await user.click(screen.getByRole('button', { name: /submit/i }))

    await waitFor(() => {
      expect(screen.getByText('targetUrl must be a valid http(s) URL')).toBeInTheDocument()
    })
  })

  it('shows the server error message on a 403 free-tier limit', async () => {
    mockFetch({
      get: { status: 200, json: CHALLENGE },
      post: { status: 403, json: { error: 'free tier is limited to 2 challenges' } },
    })
    const user = userEvent.setup()

    render(<ChallengeDetailPage params={{ id: 'todo-api-crud' }} />)
    await waitFor(() => screen.getByText('Build a Todo CRUD API'))

    await user.type(screen.getByLabelText(/api url/i), 'https://candidate.example.com')
    await user.click(screen.getByLabelText(/authorized to test/i))
    await user.click(screen.getByRole('button', { name: /submit/i }))

    await waitFor(() => {
      expect(screen.getByText('free tier is limited to 2 challenges')).toBeInTheDocument()
    })
  })

  it('shows a generic message when the submit request fails on the network', async () => {
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.reject(new Error('network down'))
      return Promise.resolve({ status: 200, json: async () => CHALLENGE })
    }) as any
    const user = userEvent.setup()

    render(<ChallengeDetailPage params={{ id: 'todo-api-crud' }} />)
    await waitFor(() => screen.getByText('Build a Todo CRUD API'))

    await user.type(screen.getByLabelText(/api url/i), 'https://candidate.example.com')
    await user.click(screen.getByLabelText(/authorized to test/i))
    await user.click(screen.getByRole('button', { name: /submit/i }))

    await waitFor(() => {
      expect(screen.getByText('Something went wrong submitting your run.')).toBeInTheDocument()
    })
  })

  it('redirects to /accept-terms when ToS acceptance is required', async () => {
    mockFetch({
      me: { status: 200, json: { ...ME, tosAcceptanceRequired: true } },
      get: { status: 200, json: CHALLENGE },
    })

    render(<ChallengeDetailPage params={{ id: 'todo-api-crud' }} />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/accept-terms')
    })
  })
})
