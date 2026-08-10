import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcceptTermsPage from '../app/accept-terms/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}))

const ME_REQUIRED = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: false, tosAcceptanceRequired: true }
const ME_NOT_REQUIRED = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: false, tosAcceptanceRequired: false }
const TOS_CURRENT = { id: 'tos-1', content: 'Be excellent to each other.', publishedAt: '2026-01-01T00:00:00.000Z' }

function mockFetch(routes: {
  me?: { status: number; json?: unknown }
  tos?: { status: number; json?: unknown }
  accept?: { status: number; json?: unknown }
}) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/api/me')) return Promise.resolve({ status: routes.me?.status ?? 500, json: async () => routes.me?.json })
    if (url.includes('/api/tos/accept')) return Promise.resolve({ status: routes.accept?.status ?? 500, json: async () => routes.accept?.json })
    if (url.includes('/api/tos/current')) return Promise.resolve({ status: routes.tos?.status ?? 500, json: async () => routes.tos?.json })
    return Promise.resolve({ status: 500, json: async () => ({}) })
  }) as any
}

describe('AcceptTermsPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
    // Stub window.location with a mock reload method for this test suite
    vi.stubGlobal('location', {
      ...window.location,
      reload: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('redirects to /dashboard when acceptance is not required', async () => {
    mockFetch({ me: { status: 200, json: ME_NOT_REQUIRED }, tos: { status: 200, json: TOS_CURRENT } })

    render(<AcceptTermsPage />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/dashboard')
    })
  })

  it('redirects to /dashboard when no ToS is configured', async () => {
    mockFetch({ me: { status: 200, json: ME_REQUIRED }, tos: { status: 404, json: { error: 'tos_not_configured' } } })

    render(<AcceptTermsPage />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/dashboard')
    })
  })

  it('renders the content with the continue button disabled until checked', async () => {
    mockFetch({ me: { status: 200, json: ME_REQUIRED }, tos: { status: 200, json: TOS_CURRENT } })

    render(<AcceptTermsPage />)

    await waitFor(() => {
      expect(screen.getByText('Be excellent to each other.')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled()
  })

  it('accepts and navigates to /dashboard', async () => {
    mockFetch({
      me: { status: 200, json: ME_REQUIRED },
      tos: { status: 200, json: TOS_CURRENT },
      accept: { status: 200, json: { ok: true } },
    })
    const user = userEvent.setup()

    render(<AcceptTermsPage />)
    await waitFor(() => screen.getByText('Be excellent to each other.'))

    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/dashboard')
    })
  })

  it('shows a re-review message on a stale version without navigating to /dashboard', async () => {
    mockFetch({
      me: { status: 200, json: ME_REQUIRED },
      tos: { status: 200, json: TOS_CURRENT },
      accept: { status: 409, json: { error: 'stale_version' } },
    })
    const user = userEvent.setup()
    vi.spyOn(window.location, 'reload').mockImplementation(() => {})

    render(<AcceptTermsPage />)
    await waitFor(() => screen.getByText('Be excellent to each other.'))

    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => {
      expect(screen.getByText(/terms were updated/i)).toBeInTheDocument()
    })
    expect(replaceMock).not.toHaveBeenCalledWith('/dashboard')
  })
})
