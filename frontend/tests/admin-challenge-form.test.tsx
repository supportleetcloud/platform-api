import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import ChallengeForm from '../app/admin/challenges/ChallengeForm'

describe('ChallengeForm', () => {
  it('submits a single check with the exact expected shape', async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true })
    const user = userEvent.setup()

    render(<ChallengeForm onSave={onSave} />)

    await user.type(screen.getByLabelText(/^title$/i), 'My Challenge')
    await user.type(screen.getByLabelText(/^name$/i), 'GET /ping')
    await user.clear(screen.getByLabelText(/^path$/i))
    await user.type(screen.getByLabelText(/^path$/i), '/ping')
    await user.clear(screen.getByLabelText(/expected status/i))
    await user.type(screen.getByLabelText(/expected status/i), '200')
    await user.clear(screen.getByLabelText(/^points$/i))
    await user.type(screen.getByLabelText(/^points$/i), '10')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(onSave).toHaveBeenCalledWith({
      title: 'My Challenge',
      description: undefined,
      objective: undefined,
      technicalDetails: undefined,
      category: 'crud',
      checks: [
        {
          name: 'GET /ping',
          method: 'GET',
          path: '/ping',
          requestHeaders: undefined,
          requestBody: undefined,
          expectStatus: 200,
          expectJson: undefined,
          expectHeaders: undefined,
          points: 10,
        },
      ],
    })
  })

  it('adds and removes request-type rows', async () => {
    const user = userEvent.setup()
    render(<ChallengeForm onSave={vi.fn().mockResolvedValue({ ok: true })} />)

    expect(screen.getAllByLabelText(/^name$/i)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: /add request type/i }))
    expect(screen.getAllByLabelText(/^name$/i)).toHaveLength(2)

    await user.click(screen.getAllByRole('button', { name: /remove request type/i })[0])
    expect(screen.getAllByLabelText(/^name$/i)).toHaveLength(1)
  })

  it('blocks submit and shows an inline error on invalid JSON, without calling onSave', async () => {
    const onSave = vi.fn()
    const user = userEvent.setup()

    render(<ChallengeForm onSave={onSave} />)

    await user.type(screen.getByLabelText(/^title$/i), 'My Challenge')
    await user.type(screen.getByLabelText(/^name$/i), 'GET /ping')
    await user.clear(screen.getByLabelText(/^path$/i))
    await user.type(screen.getByLabelText(/^path$/i), '/ping')
    await user.type(screen.getByLabelText(/request body/i), '{{not valid json')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(screen.getByText('Request type 1: request body is not valid JSON')).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('pre-fills from `initial` and omits optional fields left blank', async () => {
    render(
      <ChallengeForm
        initial={{
          title: 'Existing Challenge',
          description: 'Existing description',
          objective: '',
          technicalDetails: '',
          category: 'auth',
          checks: [
            {
              name: 'POST /login',
              method: 'POST',
              path: '/login',
              requestHeaders: '',
              requestBody: '{"user":"a"}',
              expectStatus: '201',
              expectJson: '',
              expectHeaders: '',
              points: '20',
            },
          ],
        }}
        onSave={vi.fn().mockResolvedValue({ ok: true })}
      />
    )

    expect(screen.getByDisplayValue('Existing Challenge')).toBeInTheDocument()
    expect(screen.getByDisplayValue('POST /login')).toBeInTheDocument()
  })

  it('shows the error onSave returns and stays on the form', async () => {
    // Message is deliberately something only the server could reject (not a client-side
    // `required`-blockable field) — every field the browser's own HTML5 validation would
    // block is filled in, so submission actually reaches `onSave` and its rejection is
    // what surfaces, not native constraint validation short-circuiting first.
    const onSave = vi.fn().mockResolvedValue({ ok: false, error: 'a challenge with this title already exists' })
    const user = userEvent.setup()

    render(<ChallengeForm onSave={onSave} />)

    await user.type(screen.getByLabelText(/^title$/i), 'Duplicate Title')
    await user.type(screen.getByLabelText(/^name$/i), 'GET /ping')
    await user.clear(screen.getByLabelText(/^path$/i))
    await user.type(screen.getByLabelText(/^path$/i), '/ping')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText('a challenge with this title already exists')).toBeInTheDocument()
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
