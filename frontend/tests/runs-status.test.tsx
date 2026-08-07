import { render, screen, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import RunStatusPage from '../app/runs/[id]/page'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
}))

function jsonResponse(status: number, json?: unknown) {
  return Promise.resolve({ status, json: async () => json })
}

describe('RunStatusPage', () => {
  beforeEach(() => {
    replaceMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls while pending and stops once completed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse(200, { runId: 'run-1', status: 'pending', score: null, checks: null, error: null })
      )
      .mockImplementationOnce(() =>
        jsonResponse(200, {
          runId: 'run-1',
          status: 'completed',
          score: 100,
          checks: [{ name: 'check one', status: 'passed', points: 10, pointsEarned: 10 }],
          error: null,
        })
      )
    global.fetch = fetchMock as any

    render(<RunStatusPage params={{ id: 'run-1' }} />)

    await waitFor(() => expect(screen.getByText(/running your submission/i)).toBeInTheDocument())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    await waitFor(() => expect(screen.getByText('Score: 100')).toBeInTheDocument())

    const callsAfterCompletion = fetchMock.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(fetchMock.mock.calls.length).toBe(callsAfterCompletion)
  })

  it('shows the error message for a failed run', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        await jsonResponse(200, {
          runId: 'run-2',
          status: 'error',
          score: null,
          checks: null,
          error: 'challenge YAML failed to parse',
        })
      ) as any

    render(<RunStatusPage params={{ id: 'run-2' }} />)

    await waitFor(() => {
      expect(screen.getByText('challenge YAML failed to parse')).toBeInTheDocument()
    })
  })

  it('shows a timed-out message for a stale pending run', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        await jsonResponse(200, {
          runId: 'run-3',
          status: 'timed_out',
          score: null,
          checks: null,
          error: null,
        })
      ) as any

    render(<RunStatusPage params={{ id: 'run-3' }} />)

    await waitFor(() => {
      expect(screen.getByText(/taking longer than expected/i)).toBeInTheDocument()
    })
  })

  it('shows "Run not found" for a 404 without redirecting', async () => {
    global.fetch = vi.fn().mockResolvedValue(await jsonResponse(404, { error: 'run_not_found' })) as any

    render(<RunStatusPage params={{ id: 'does-not-exist' }} />)

    await waitFor(() => {
      expect(screen.getByText('Run not found.')).toBeInTheDocument()
    })
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('redirects to the login page when the session is missing', async () => {
    global.fetch = vi.fn().mockResolvedValue(await jsonResponse(401)) as any

    render(<RunStatusPage params={{ id: 'run-4' }} />)

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/')
    })
  })
})
