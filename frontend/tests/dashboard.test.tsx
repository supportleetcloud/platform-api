import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import DashboardPage from '../app/dashboard/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
}))

describe('DashboardPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
  })

  it('shows the username when the session is valid', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ id: '1', username: 'octocat', avatarUrl: null, isAdmin: false }),
    }) as any

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/welcome, octocat/i)).toBeInTheDocument()
    })
  })

  it('redirects to the login page when the session is missing', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 401 }) as any

    render(<DashboardPage />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/')
    })
  })
})
