import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import DashboardPage from '../app/dashboard/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
}))

const ME_RESPONSE = {
  id: '1',
  username: 'octocat',
  avatarUrl: null,
  isAdmin: false,
  tosAcceptanceRequired: false,
  hideFromRanking: false,
}
const CHALLENGES_RESPONSE = [
  { id: 'todo-api-crud', title: 'Build a Todo CRUD API', category: 'crud', points: 25 },
]

function mockFetch(routes: Record<string, { status: number; json?: unknown }> & { put?: { status: number; json?: unknown } }) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const route = routes.put ?? { status: 500 }
      return Promise.resolve({ status: route.status, json: async () => route.json })
    }
    const match = Object.keys(routes).find((path) => path !== 'put' && url.includes(path))
    const route = match ? (routes as Record<string, { status: number; json?: unknown }>)[match] : { status: 500 }
    return Promise.resolve({
      status: route.status,
      json: async () => route.json,
    })
  }) as any
}

describe('DashboardPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
  })

  it('shows the username when the session is valid', async () => {
    mockFetch({
      '/api/me': { status: 200, json: ME_RESPONSE },
      '/api/challenges': { status: 200, json: [] },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/welcome, octocat/i)).toBeInTheDocument()
    })
  })

  it('renders a Ranking link pointing to /ranking', async () => {
    mockFetch({
      '/api/me': { status: 200, json: ME_RESPONSE },
      '/api/challenges': { status: 200, json: [] },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/welcome, octocat/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: 'Ranking' })).toHaveAttribute('href', '/ranking')
  })

  it('redirects to the login page when the session is missing', async () => {
    mockFetch({
      '/api/me': { status: 401 },
      '/api/challenges': { status: 200, json: [] },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/')
    })
  })

  it('shows an error message instead of an infinite spinner when the backend request fails', async () => {
    mockFetch({
      '/api/me': { status: 500 },
      '/api/challenges': { status: 200, json: [] },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/something went wrong loading your dashboard/i)).toBeInTheDocument()
    })

    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
  })

  it('renders the challenge list', async () => {
    mockFetch({
      '/api/me': { status: 200, json: ME_RESPONSE },
      '/api/challenges': { status: 200, json: CHALLENGES_RESPONSE },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/build a todo crud api/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: /build a todo crud api/i })).toHaveAttribute(
      'href',
      '/challenges/todo-api-crud'
    )
  })

  it('shows a message when the challenge list fails to load', async () => {
    mockFetch({
      '/api/me': { status: 200, json: ME_RESPONSE },
      '/api/challenges': { status: 500 },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/could not load challenges/i)).toBeInTheDocument()
    })
  })

  it('redirects to /accept-terms when ToS acceptance is required', async () => {
    mockFetch({
      '/api/me': { status: 200, json: { ...ME_RESPONSE, tosAcceptanceRequired: true } },
      '/api/challenges': { status: 200, json: [] },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/accept-terms')
    })
  })

  it('toggles hideFromRanking via PUT /api/me and reflects the new value', async () => {
    mockFetch({
      '/api/me': { status: 200, json: ME_RESPONSE },
      '/api/challenges': { status: 200, json: [] },
      put: { status: 200, json: { ...ME_RESPONSE, hideFromRanking: true } },
    })
    const user = userEvent.setup()

    render(<DashboardPage />)
    await waitFor(() => screen.getByLabelText(/hide from public ranking/i))

    const checkbox = screen.getByLabelText(/hide from public ranking/i) as HTMLInputElement
    expect(checkbox.checked).toBe(false)

    await user.click(checkbox)

    await waitFor(() => {
      expect(checkbox.checked).toBe(true)
    })

    const putCall = (global.fetch as any).mock.calls.find((call: any[]) => call[1]?.method === 'PUT')
    expect(JSON.parse(putCall[1].body)).toEqual({ hideFromRanking: true })
  })

  it('reverts the checkbox and shows an error when the PUT fails', async () => {
    mockFetch({
      '/api/me': { status: 200, json: ME_RESPONSE },
      '/api/challenges': { status: 200, json: [] },
      put: { status: 500 },
    })
    const user = userEvent.setup()

    render(<DashboardPage />)
    await waitFor(() => screen.getByLabelText(/hide from public ranking/i))

    const checkbox = screen.getByLabelText(/hide from public ranking/i) as HTMLInputElement
    await user.click(checkbox)

    await waitFor(() => {
      expect(checkbox.checked).toBe(false)
    })
    expect(screen.getByText(/could not save/i)).toBeInTheDocument()
  })
})
