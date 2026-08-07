import { generateFeedback, LlmProviderConfig, FeedbackPromptInput } from '../src/llm/providers'

const INPUT: FeedbackPromptInput = {
  challengeTitle: 'Build a Todo CRUD API',
  score: 85,
  checks: [
    { name: 'POST /todos creates a todo', status: 'passed', points: 10, pointsEarned: 10 },
    { name: 'DELETE /todos/{id} removes it', status: 'failed', points: 5, pointsEarned: 0 },
  ],
}

describe('generateFeedback', () => {
  it('calls the Claude Messages API with the right shape', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ text: 'Nice work on the create endpoint.' }] }),
    }) as any
    const config: LlmProviderConfig = { provider: 'claude', model: 'claude-sonnet-5', baseUrl: null, apiKey: 'sk-test' }

    const feedback = await generateFeedback(fetchImpl, config, INPUT)

    expect(feedback).toBe('Nice work on the create endpoint.')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(options.headers['x-api-key']).toBe('sk-test')
    expect(options.headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('claude-sonnet-5')
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].content).toContain('Build a Todo CRUD API')
    expect(body.messages[0].content).toContain('POST /todos creates a todo')
  })

  it('calls the OpenAI Chat Completions API with the right shape', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Good effort.' } }] }),
    }) as any
    const config: LlmProviderConfig = { provider: 'openai', model: 'gpt-4o', baseUrl: null, apiKey: 'sk-openai' }

    const feedback = await generateFeedback(fetchImpl, config, INPUT)

    expect(feedback).toBe('Good effort.')
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(options.headers.Authorization).toBe('Bearer sk-openai')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('gpt-4o')
  })

  it('calls the OpenRouter API with the right shape', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Solid submission.' } }] }),
    }) as any
    const config: LlmProviderConfig = {
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
      baseUrl: null,
      apiKey: 'sk-openrouter',
    }

    const feedback = await generateFeedback(fetchImpl, config, INPUT)

    expect(feedback).toBe('Solid submission.')
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(options.headers.Authorization).toBe('Bearer sk-openrouter')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('anthropic/claude-3.5-sonnet')
  })

  it('calls the Ollama local API with the right shape', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'Keep practicing.' }),
    }) as any
    const config: LlmProviderConfig = {
      provider: 'ollama',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
      apiKey: null,
    }

    const feedback = await generateFeedback(fetchImpl, config, INPUT)

    expect(feedback).toBe('Keep practicing.')
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/generate')
    const body = JSON.parse(options.body)
    expect(body.model).toBe('llama3.1')
    expect(body.stream).toBe(false)
  })

  it('throws when a provider responds with a non-2xx status', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any
    const config: LlmProviderConfig = { provider: 'claude', model: 'claude-sonnet-5', baseUrl: null, apiKey: 'sk-test' }

    await expect(generateFeedback(fetchImpl, config, INPUT)).rejects.toThrow()
  })
})
