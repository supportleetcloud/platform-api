import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import RankingPage from '../app/ranking/page'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

const RANKING = [
  { userId: '1', username: 'alice', avatarUrl: null, totalScore: 150, challengesAttempted: 2 },
  { userId: '2', username: 'bob', avatarUrl: null, totalScore: 90, challengesAttempted: 1 },
]

function mockFetch(routes: { get?: { status: number; json?: unknown } }) {
  global.fetch = vi.fn(() => {
    const route = routes.get
    return Promise.resolve({ status: route?.status ?? 500, json: async () => route?.json })
  }) as any
}

describe('RankingPage', () => {
  it('never fetches /api/me', async () => {
    mockFetch({ get: { status: 200, json: RANKING } })

    render(<RankingPage />)
    await waitFor(() => screen.getByText(/alice/))

    const calledUrls = (global.fetch as any).mock.calls.map((call: any[]) => call[0])
    expect(calledUrls.some((url: string) => url.includes('/api/me'))).toBe(false)
  })

  it('renders each entry with rank position, username, and score, linking to the profile', async () => {
    mockFetch({ get: { status: 200, json: RANKING } })

    render(<RankingPage />)

    await waitFor(() => screen.getByText(/alice/))
    expect(screen.getByText(/bob/)).toBeInTheDocument()
    expect(screen.getByText(/150/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /alice/i })).toHaveAttribute('href', '/u/alice')
  })

  it('shows an error message instead of an infinite spinner when the request fails', async () => {
    mockFetch({ get: { status: 500 } })

    render(<RankingPage />)

    await waitFor(() => {
      expect(screen.getByText(/could not load the ranking/i)).toBeInTheDocument()
    })
  })
})
