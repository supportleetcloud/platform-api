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

function deferred<T = unknown>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
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

  it('does not let a stale, slow poll response overwrite a newer completed response', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { promise: slowPollPromise, resolve: resolveSlowPoll } = deferred<{
      status: number
      json: () => Promise<unknown>
    }>()

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse(200, { runId: 'run-1', status: 'pending', score: null, checks: null, error: null })
      )
      .mockImplementationOnce(() => slowPollPromise)
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

    // Poll #2 fires but stays in flight — its response has not resolved yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    // Poll #3 fires and resolves immediately with the terminal, completed status.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    await waitFor(() => expect(screen.getByText('Score: 100')).toBeInTheDocument())

    // Now the stale poll #2 finally resolves, after poll #3 already rendered
    // and cleared the interval. It must be discarded, not overwrite the
    // completed state.
    await act(async () => {
      resolveSlowPoll(
        await jsonResponse(200, { runId: 'run-1', status: 'pending', score: null, checks: null, error: null })
      )
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(screen.getByText('Score: 100')).toBeInTheDocument()
    expect(screen.queryByText(/running your submission/i)).not.toBeInTheDocument()
  })

  it('keeps polling and does not surface an error after a transient mid-poll failure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse(200, { runId: 'run-1', status: 'pending', score: null, checks: null, error: null })
      )
      .mockImplementationOnce(() => Promise.reject(new Error('network blip')))
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

    // Poll #2 hits a transient failure — must not surface an error or stop polling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(screen.getByText(/running your submission/i)).toBeInTheDocument()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()

    // Poll #3 succeeds, proving the interval survived the earlier failure.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    await waitFor(() => expect(screen.getByText('Score: 100')).toBeInTheDocument())
    expect(fetchMock.mock.calls.length).toBe(3)
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
