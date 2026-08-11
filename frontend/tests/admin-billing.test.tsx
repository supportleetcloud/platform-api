import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminBillingPage from '../app/admin/billing/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}))

const ADMIN_ME = { id: '1', username: 'octocat', avatarUrl: null, isAdmin: true }
const NON_ADMIN_ME = { id: '2', username: 'someone', avatarUrl: null, isAdmin: false }
const SETTINGS = { priceCents: 999, currency: 'usd' }

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

describe('AdminBillingPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
  })

  it('shows "Not authorized." for a non-admin user', async () => {
    mockFetch({ me: { status: 200, json: NON_ADMIN_ME }, get: { status: 200, json: SETTINGS } })

    render(<AdminBillingPage />)

    await waitFor(() => {
      expect(screen.getByText('Not authorized.')).toBeInTheDocument()
    })
  })

  it('renders the form pre-filled with the current price for an admin', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: SETTINGS } })

    render(<AdminBillingPage />)

    await waitFor(() => {
      expect(screen.getByDisplayValue('9.99')).toBeInTheDocument()
    })
  })

  it('renders an empty price field when billing is not configured yet', async () => {
    mockFetch({ me: { status: 200, json: ADMIN_ME }, get: { status: 200, json: null } })

    render(<AdminBillingPage />)

    await waitFor(() => {
      expect(screen.getByLabelText(/monthly price/i)).toBeInTheDocument()
    })
    expect((screen.getByLabelText(/monthly price/i) as HTMLInputElement).value).toBe('')
  })

  it('saves successfully, converting dollars to cents, and shows a confirmation', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: SETTINGS },
      put: { status: 200, json: { priceCents: 1999, currency: 'usd' } },
    })
    const user = userEvent.setup()

    render(<AdminBillingPage />)
    await waitFor(() => screen.getByDisplayValue('9.99'))

    await user.clear(screen.getByLabelText(/monthly price/i))
    await user.type(screen.getByLabelText(/monthly price/i), '19.99')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(screen.getByText('Price saved.')).toBeInTheDocument()
    })

    const putCall = (global.fetch as any).mock.calls.find((call: any[]) => call[1]?.method === 'PUT')
    expect(JSON.parse(putCall[1].body)).toEqual({ amountCents: 1999 })
  })

  it('shows the server error message on a validation failure', async () => {
    mockFetch({
      me: { status: 200, json: ADMIN_ME },
      get: { status: 200, json: SETTINGS },
      put: { status: 400, json: { error: 'amountCents must be a positive integer' } },
    })
    const user = userEvent.setup()

    render(<AdminBillingPage />)
    await waitFor(() => screen.getByDisplayValue('9.99'))

    await user.clear(screen.getByLabelText(/monthly price/i))
    await user.type(screen.getByLabelText(/monthly price/i), '0')
    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(screen.getByText('amountCents must be a positive integer')).toBeInTheDocument()
    })
  })
})
