export type LlmProviderConfig = {
  provider: 'claude' | 'openai' | 'openrouter' | 'ollama'
  model: string
  baseUrl: string | null
  apiKey: string | null
}

export type FeedbackCheck = {
  name: string
  status: string
  points: number
  pointsEarned: number
}

export type FeedbackPromptInput = {
  challengeTitle: string
  score: number
  checks: FeedbackCheck[]
}

const PROVIDER_TIMEOUT_MS = 30000

function buildPrompt(input: FeedbackPromptInput): string {
  const checksSummary = input.checks
    .map((check) => `- ${check.name}: ${check.status} (${check.pointsEarned}/${check.points} points)`)
    .join('\n')

  return `You are giving feedback to a developer who just completed a coding challenge called "${input.challengeTitle}".

They scored ${input.score} points. Here are the results of each check:

${checksSummary}

Write a short, encouraging paragraph (3-5 sentences) of constructive feedback. Point out what they did well and, for any failed or partially-passed checks, give a concrete hint about what likely went wrong — without giving away the exact fix. Keep it friendly and specific to their actual results, not generic.`
}

async function callWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function callClaude(fetchImpl: typeof fetch, config: LlmProviderConfig, prompt: string): Promise<string> {
  const response = await callWithTimeout(fetchImpl, 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: config.model, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!response.ok) {
    throw new Error(`claude responded ${response.status}`)
  }
  const body = await response.json()
  return body.content[0].text
}

async function callOpenaiCompatible(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string | null,
  model: string,
  prompt: string
): Promise<string> {
  const response = await callWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey ?? ''}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!response.ok) {
    throw new Error(`provider responded ${response.status}`)
  }
  const body = await response.json()
  return body.choices[0].message.content
}

async function callOllama(fetchImpl: typeof fetch, config: LlmProviderConfig, prompt: string): Promise<string> {
  const response = await callWithTimeout(fetchImpl, `${config.baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, prompt, stream: false }),
  })
  if (!response.ok) {
    throw new Error(`ollama responded ${response.status}`)
  }
  const body = await response.json()
  return body.response
}

export async function generateFeedback(
  fetchImpl: typeof fetch,
  config: LlmProviderConfig,
  input: FeedbackPromptInput
): Promise<string> {
  const prompt = buildPrompt(input)

  if (config.provider === 'claude') {
    return callClaude(fetchImpl, config, prompt)
  }
  if (config.provider === 'openai') {
    return callOpenaiCompatible(fetchImpl, 'https://api.openai.com/v1/chat/completions', config.apiKey, config.model, prompt)
  }
  if (config.provider === 'openrouter') {
    return callOpenaiCompatible(fetchImpl, 'https://openrouter.ai/api/v1/chat/completions', config.apiKey, config.model, prompt)
  }
  return callOllama(fetchImpl, config, prompt)
}
