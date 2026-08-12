import { listOllamaModels } from '../src/llm/ollama'

describe('listOllamaModels', () => {
  it('returns the model names from a successful /api/tags response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: 'llama3:latest' }, { name: 'mistral:latest' }],
      }),
    }) as any

    const models = await listOllamaModels(fetchImpl, 'http://localhost:11434')

    expect(models).toEqual(['llama3:latest', 'mistral:latest'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/tags')
  })

  it('returns an empty array when the response has no models field', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as any

    const models = await listOllamaModels(fetchImpl, 'http://localhost:11434')

    expect(models).toEqual([])
  })

  it('throws when the response is not ok', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as any

    await expect(listOllamaModels(fetchImpl, 'http://localhost:11434')).rejects.toThrow()
  })

  it('throws when the fetch itself fails (e.g. connection refused)', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as any

    await expect(listOllamaModels(fetchImpl, 'http://localhost:11434')).rejects.toThrow()
  })

  it('filters out entries that do not have a string name', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: 'llama3' }, null, { name: 42 }, {}],
      }),
    }) as any

    const models = await listOllamaModels(fetchImpl, 'http://localhost:11434')

    expect(models).toEqual(['llama3'])
  })

  it('returns an empty array when the response body is null', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => null,
    }) as any

    const models = await listOllamaModels(fetchImpl, 'http://localhost:11434')

    expect(models).toEqual([])
  })
})
