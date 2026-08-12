const OLLAMA_MODELS_TIMEOUT_MS = 5000

export async function listOllamaModels(fetchImpl: typeof fetch, baseUrl: string): Promise<string[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OLLAMA_MODELS_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}/api/tags`, { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    throw new Error(`ollama responded ${response.status}`)
  }

  const body = await response.json()
  const models = Array.isArray(body.models) ? body.models : []
  return models.map((model: { name: string }) => model.name)
}
