import { PrismaClient } from '@prisma/client'
import {
  encrypt,
  decrypt,
  getLlmSettings,
  saveLlmSettings,
  getLlmSettingsForGeneration,
} from '../src/llm/settings'

const prisma = new PrismaClient()

describe('encrypt/decrypt', () => {
  it('round-trips a plaintext string', () => {
    const ciphertext = encrypt('sk-test-12345')
    expect(ciphertext).not.toBe('sk-test-12345')
    expect(decrypt(ciphertext)).toBe('sk-test-12345')
  })
})

describe('saveLlmSettings / getLlmSettings / getLlmSettingsForGeneration', () => {
  afterEach(async () => {
    await prisma.llmSettings.deleteMany({})
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('returns not_configured before any save', async () => {
    const result = await getLlmSettingsForGeneration(prisma)
    expect(result).toEqual({ kind: 'not_configured' })
  })

  it('rejects an unknown provider', async () => {
    const result = await saveLlmSettings(prisma, { provider: 'bogus', model: 'x' })
    expect(result.kind).toBe('validation_error')
  })

  it('rejects a missing model', async () => {
    const result = await saveLlmSettings(prisma, { provider: 'claude', model: '', apiKey: 'sk-test' })
    expect(result.kind).toBe('validation_error')
  })

  it('rejects ollama without a baseUrl', async () => {
    const result = await saveLlmSettings(prisma, { provider: 'ollama', model: 'llama3.1' })
    expect(result.kind).toBe('validation_error')
  })

  it('rejects claude/openai/openrouter with no apiKey and none on file', async () => {
    const result = await saveLlmSettings(prisma, { provider: 'claude', model: 'claude-sonnet-5' })
    expect(result.kind).toBe('validation_error')
  })

  it('saves ollama settings with no apiKey required', async () => {
    const result = await saveLlmSettings(prisma, {
      provider: 'ollama',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
    })
    expect(result.kind).toBe('saved')

    const settings = await getLlmSettings(prisma)
    expect(settings).toEqual({
      provider: 'ollama',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
      apiKeySet: false,
    })
  })

  it('saves claude settings and never exposes the key via getLlmSettings', async () => {
    const result = await saveLlmSettings(prisma, {
      provider: 'claude',
      model: 'claude-sonnet-5',
      apiKey: 'sk-real-secret',
    })
    expect(result.kind).toBe('saved')

    const settings = await getLlmSettings(prisma)
    expect(settings).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-5',
      baseUrl: null,
      apiKeySet: true,
    })
    expect(JSON.stringify(settings)).not.toContain('sk-real-secret')
  })

  it('keeps the existing key when a later save for the same provider omits apiKey', async () => {
    await saveLlmSettings(prisma, { provider: 'claude', model: 'claude-sonnet-5', apiKey: 'sk-original' })
    const result = await saveLlmSettings(prisma, { provider: 'claude', model: 'claude-opus-5' })
    expect(result.kind).toBe('saved')

    const forGeneration = await getLlmSettingsForGeneration(prisma)
    expect(forGeneration).toEqual({
      kind: 'configured',
      config: { provider: 'claude', model: 'claude-opus-5', baseUrl: null, apiKey: 'sk-original' },
    })
  })

  it('requires a fresh apiKey when switching provider, even if a different provider key is on file', async () => {
    await saveLlmSettings(prisma, { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-openai-key' })
    const result = await saveLlmSettings(prisma, { provider: 'claude', model: 'claude-sonnet-5' })
    expect(result.kind).toBe('validation_error')
  })
})
