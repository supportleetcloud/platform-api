import { PrismaClient } from '@prisma/client'
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const SETTINGS_ID = 'singleton'
const KNOWN_PROVIDERS = ['claude', 'openai', 'openrouter', 'ollama']

function encryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    throw new Error('ENCRYPTION_KEY is not set')
  }
  return Buffer.from(raw, 'base64')
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`
}

export function decrypt(encrypted: string): string {
  const [ivB64, authTagB64, ciphertextB64] = encrypted.split(':')
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ])
  return plaintext.toString('utf-8')
}

export type LlmSettingsView = {
  provider: string | null
  model: string | null
  baseUrl: string | null
  apiKeySet: boolean
}

export async function getLlmSettings(prisma: PrismaClient): Promise<LlmSettingsView> {
  const settings = await prisma.llmSettings.findUnique({ where: { id: SETTINGS_ID } })
  if (!settings) {
    return { provider: null, model: null, baseUrl: null, apiKeySet: false }
  }
  return {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    apiKeySet: settings.apiKeyEncrypted !== null,
  }
}

export type SaveLlmSettingsInput = {
  provider: string
  model: string
  baseUrl?: string
  apiKey?: string
}

export type SaveLlmSettingsResult = { kind: 'saved' } | { kind: 'validation_error'; error: string }

export async function saveLlmSettings(
  prisma: PrismaClient,
  input: SaveLlmSettingsInput
): Promise<SaveLlmSettingsResult> {
  if (!KNOWN_PROVIDERS.includes(input.provider)) {
    return { kind: 'validation_error', error: 'provider must be one of: claude, openai, openrouter, ollama' }
  }
  if (typeof input.model !== 'string' || input.model.trim().length === 0) {
    return { kind: 'validation_error', error: 'model is required' }
  }
  if (input.provider === 'ollama' && (typeof input.baseUrl !== 'string' || input.baseUrl.trim().length === 0)) {
    return { kind: 'validation_error', error: 'baseUrl is required for ollama' }
  }

  const existing = await prisma.llmSettings.findUnique({ where: { id: SETTINGS_ID } })
  // Only ever carry an encrypted key forward when the provider hasn't changed — a key
  // encrypted for one provider (e.g. an OpenAI key) is meaningless sent to another
  // (e.g. Claude), so switching providers always demands a fresh key.
  const providerUnchanged = existing?.provider === input.provider

  let apiKeyEncrypted: string | null = providerUnchanged ? existing?.apiKeyEncrypted ?? null : null
  if (input.provider === 'ollama') {
    apiKeyEncrypted = null
  } else if (input.apiKey && input.apiKey.trim().length > 0) {
    apiKeyEncrypted = encrypt(input.apiKey)
  } else if (!apiKeyEncrypted) {
    return { kind: 'validation_error', error: 'apiKey is required' }
  }

  await prisma.llmSettings.upsert({
    where: { id: SETTINGS_ID },
    update: { provider: input.provider, model: input.model, baseUrl: input.baseUrl ?? null, apiKeyEncrypted },
    create: {
      id: SETTINGS_ID,
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl ?? null,
      apiKeyEncrypted,
    },
  })

  return { kind: 'saved' }
}

export type LlmProviderConfigForGeneration = {
  provider: 'claude' | 'openai' | 'openrouter' | 'ollama'
  model: string
  baseUrl: string | null
  apiKey: string | null
}

export type LlmProviderConfigResult =
  | { kind: 'not_configured' }
  | { kind: 'configured'; config: LlmProviderConfigForGeneration }

export async function getLlmSettingsForGeneration(prisma: PrismaClient): Promise<LlmProviderConfigResult> {
  const settings = await prisma.llmSettings.findUnique({ where: { id: SETTINGS_ID } })
  if (!settings) {
    return { kind: 'not_configured' }
  }
  return {
    kind: 'configured',
    config: {
      provider: settings.provider as 'claude' | 'openai' | 'openrouter' | 'ollama',
      model: settings.model,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKeyEncrypted ? decrypt(settings.apiKeyEncrypted) : null,
    },
  }
}
