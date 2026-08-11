import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import DashboardPage from '../app/dashboard/page'

const replaceMock = vi.fn()
let searchParamsValue = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => searchParamsValue,
}))

const ME_RESPONSE = {
  id: '1',
  username: 'octocat',
  avatarUrl: null,
  isAdmin: false,
  tosAcceptanceRequired: false,
  hideFromRanking: false,
  isPaid: false,
}
const CHALLENGES_RESPONSE = [
  { id: 'todo-api-crud', title: 'Build a Todo CRUD API', category: 'crud', points: 25 },
]
const FREE_BILLING_STATUS = { isPaid: false, priceCents: 999, currency: 'usd', cancelAtPeriodEnd: false }
const PAID_BILLING_STATUS = { isPaid: true, priceCents: 999, currency: 'usd', cancelAtPeriodEnd: false }

function mockFetch(routes: Record<string, { status: number; json?: unknown }>) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const key = Object.keys(routes).find((k) => {
      const hasMethod = k.includes(' ')
      const routeMethod = hasMethod ? k.split(' ')[0] : 'GET'
      const routePath = hasMethod ? k.split(' ')[1] : k
      return method === routeMethod && url.includes(routePath)
    })
    const route = key ? routes[key] : { status: 500 }
    return Promise.resolve({ status: route.status, json: async () => route.json })
  }) as any
}

describe('DashboardPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
    searchParamsValue = new URLSearchParams()
  })

  it('shows the username when the session is valid', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/welcome, octocat/i)).toBeInTheDocument()
    })
  })

  it('renders a Ranking link pointing to /ranking', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/welcome, octocat/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: 'Ranking' })).toHaveAttribute('href', '/ranking')
  })

  it('redirects to the login page when the session is missing', async () => {
    mockFetch({
      'GET /api/me': { status: 401 },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 401 },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/')
    })
  })

  it('shows an error message instead of an infinite spinner when the backend request fails', async () => {
    mockFetch({
      'GET /api/me': { status: 500 },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 500 },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/something went wrong loading your dashboard/i)).toBeInTheDocument()
    })

    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
  })

  it('renders the challenge list', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: CHALLENGES_RESPONSE },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
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
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 500 },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/could not load challenges/i)).toBeInTheDocument()
    })
  })

  it('redirects to /accept-terms when ToS acceptance is required', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: { ...ME_RESPONSE, tosAcceptanceRequired: true } },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/accept-terms')
    })
  })

  it('toggles hideFromRanking via PUT /api/me and reflects the new value', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
      'PUT /api/me': { status: 200, json: { ...ME_RESPONSE, hideFromRanking: true } },
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

    const putCall = (global.fetch as any).mock.calls.find(
      (call: any[]) => call[0].includes('/api/me') && call[1]?.method === 'PUT'
    )
    expect(JSON.parse(putCall[1].body)).toEqual({ hideFromRanking: true })
  })

  it('reverts the checkbox and shows an error when the PUT fails', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
      'PUT /api/me': { status: 500 },
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

  it('shows the free plan panel with an Upgrade button', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/free plan/i)).toBeInTheDocument()
      expect(screen.getByText(/\$9\.99\/mo/)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /upgrade/i })).toBeInTheDocument()
  })

  it('redirects to the Stripe checkout url on Upgrade click', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
      'POST /api/billing/checkout-session': { status: 200, json: { url: 'https://checkout.stripe.test/xyz' } },
    })
    const user = userEvent.setup()
    delete (window as any).location
    ;(window as any).location = { href: '' }

    render(<DashboardPage />)
    await waitFor(() => screen.getByRole('button', { name: /upgrade/i }))

    await user.click(screen.getByRole('button', { name: /upgrade/i }))

    await waitFor(() => {
      expect(window.location.href).toBe('https://checkout.stripe.test/xyz')
    })
  })

  it('shows the pro plan panel with a Cancel subscription button, gated by an inline confirm', async () => {
    mockFetch({
      'GET /api/me': { status: 200, json: { ...ME_RESPONSE, isPaid: true } },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: PAID_BILLING_STATUS },
      'POST /api/billing/cancel': { status: 200, json: { canceled: true } },
    })
    const user = userEvent.setup()

    render(<DashboardPage />)
    await waitFor(() => screen.getByText(/pro plan/i))

    expect(screen.queryByText(/are you sure/i)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /cancel subscription/i }))
    expect(screen.getByText(/are you sure/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /confirm cancel/i }))

    await waitFor(() => {
      expect(screen.getByText(/cancels at the end of the current billing period/i)).toBeInTheDocument()
    })
  })

  it('shows the activating banner when redirected back with ?checkout=success', async () => {
    searchParamsValue = new URLSearchParams('checkout=success')
    mockFetch({
      'GET /api/me': { status: 200, json: ME_RESPONSE },
      'GET /api/challenges': { status: 200, json: [] },
      'GET /api/billing/status': { status: 200, json: FREE_BILLING_STATUS },
    })

    render(<DashboardPage />)

    await waitFor(() => {
      expect(screen.getByText(/subscription activating/i)).toBeInTheDocument()
    })
  })
})
