import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import DashboardPage from '../app/dashboard/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
}))

const ME_RESPONSE = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: false }
const CHALLENGES_RESPONSE = [
  { id: 'todo-api-crud', title: 'Build a Todo CRUD API', category: 'crud', points: 25 },
]

function mockFetch(routes: Record<string, { status: number; json?: unknown }>) {
  global.fetch = vi.fn((url: string) => {
    const match = Object.keys(routes).find((path) => url.includes(path))
    const route = match ? routes[match] : { status: 500 }
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
})
