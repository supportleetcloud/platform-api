import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import UserProfilePage from '../app/u/[username]/page'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

const PROFILE = {
  username: 'alice',
  avatarUrl: null,
  totalScore: 150,
  rank: 1,
  challenges: [
    { challengeId: 'todo-api-crud', title: 'Build a Todo CRUD API', category: 'crud', points: 25, bestScore: 90 },
    { challengeId: 'jwt-auth-basics', title: 'JWT Auth Basics', category: 'auth', points: 25, bestScore: 60 },
  ],
}

function mockFetch(routes: { get?: { status: number; json?: unknown } }) {
  global.fetch = vi.fn(() => {
    const route = routes.get
    return Promise.resolve({ status: route?.status ?? 500, json: async () => route?.json })
  }) as any
}

describe('UserProfilePage', () => {
  it('never fetches /api/me', async () => {
    mockFetch({ get: { status: 200, json: PROFILE } })

    render(<UserProfilePage params={{ username: 'alice' }} />)
    await waitFor(() => screen.getByRole('heading', { name: 'alice' }))

    const calledUrls = (global.fetch as any).mock.calls.map((call: any[]) => call[0])
    expect(calledUrls.some((url: string) => url.includes('/api/me'))).toBe(false)
  })

  it('renders username, rank, total score, and each attempted challenge with its best score', async () => {
    mockFetch({ get: { status: 200, json: PROFILE } })

    render(<UserProfilePage params={{ username: 'alice' }} />)

    await waitFor(() => screen.getByRole('heading', { name: 'alice' }))
    expect(screen.getByText(/150/)).toBeInTheDocument()
    expect(screen.getByText('Build a Todo CRUD API')).toBeInTheDocument()
    expect(screen.getByText(/90/)).toBeInTheDocument()
    expect(screen.getByText('JWT Auth Basics')).toBeInTheDocument()
  })

  it('shows "User not found." for a 404', async () => {
    mockFetch({ get: { status: 404, json: { error: 'user_not_found' } } })

    render(<UserProfilePage params={{ username: 'does-not-exist' }} />)

    await waitFor(() => {
      expect(screen.getByText('User not found.')).toBeInTheDocument()
    })
  })

  it('shows a message instead of the challenge list when rank is 0 (no activity yet)', async () => {
    mockFetch({ get: { status: 200, json: { ...PROFILE, totalScore: 0, rank: 0, challenges: [] } } })

    render(<UserProfilePage params={{ username: 'alice' }} />)

    await waitFor(() => {
      expect(screen.getByText(/not yet ranked/i)).toBeInTheDocument()
    })
  })
})
