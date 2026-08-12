# Ollama model listing in admin LLM settings — design

## Problem

The admin LLM settings page (`frontend/app/admin/llm-settings/page.tsx`) has a free-text "Model" input for every provider, including Ollama. For Ollama, the admin has to already know the exact model name/tag installed on their server (`llama3:latest`, etc.) and type it correctly — no discovery, no validation against what's actually pulled.

## Goal

When the provider is Ollama, list the models actually available on the configured Ollama server and let the admin pick one from a dropdown, instead of typing blind.

## Architecture

The browser cannot reliably call the Ollama server's `/api/tags` endpoint directly — Ollama does not set CORS headers for arbitrary origins by default, so a `fetch` from `localhost:3000` to `localhost:11434` (or any other Ollama host) fails silently in the browser. The backend proxies the call instead, following the existing admin API pattern: a new admin-gated route on this project's own backend fetches `{baseUrl}/api/tags` server-side and returns the parsed model list.

## Components

- **`backend/src/llm/ollama.ts`** (new file): `listOllamaModels(fetchImpl: typeof fetch, baseUrl: string): Promise<string[]>`. Calls `GET {baseUrl}/api/tags`, applies a short timeout (5s — this is a synchronous admin-UI request, not a background job, so it must fail fast), and maps the response's `models` array to `model.name`. Throws on network failure, timeout, or a non-OK response — the route layer translates the throw into an HTTP error.
- **`backend/src/admin/routes.ts`**: new route `GET /api/admin/llm-settings/ollama-models`, gated by the same `requireAuth, requireAdmin` middleware chain as every other admin route. Reads `baseUrl` from the query string.
  - Missing or empty `baseUrl` → `400 { error: 'baseUrl is required' }`.
  - `listOllamaModels` throws (network error, timeout, non-OK response) → `502 { error: 'could not reach ollama' }`.
  - Success → `200 { models: string[] }`. An empty array is a valid, successful response (Ollama reachable, nothing pulled) — the frontend treats an empty list the same as a fetch failure for UI purposes (see Error handling), but the route itself does not error on it.
- **`frontend/app/admin/llm-settings/page.tsx`**: new state — `ollamaModels: string[]`, `modelsLoading: boolean`, `modelsError: string | null`.

## Data flow

Fetching the model list is automatic, no explicit button:

1. Provider changes to `ollama` and `baseUrl` is already non-empty (e.g. loaded from saved settings) → fetch fires immediately.
2. While provider is `ollama`, the admin edits the Base URL field and blurs it (`onBlur`) → fetch fires with the new value.

Both triggers call the same function: `GET /api/admin/llm-settings/ollama-models?baseUrl=<value>` via `backendFetch`, setting `modelsLoading` true until it resolves.

**Model field rendering when `provider === 'ollama'`:**
- `modelsLoading` → `<select>` disabled, single option "Loading models…".
- Fetch succeeded with a non-empty list, no error → `<select>` populated with one `<option>` per model name; `value={model}` preserves the current selection if it's still in the list, otherwise the select falls back to its first option.
- Fetch failed, or succeeded with an empty list → see Error handling.

Switching the provider away from `ollama` reverts the Model field to the existing plain `<input>` text box unconditionally and clears `ollamaModels`/`modelsError` — no cross-provider state leakage.

## Error handling

A failed fetch (network error, timeout, non-2xx from the backend route) or a successful-but-empty model list both render the same fallback: an error message below the Model field ("Não foi possível listar modelos do Ollama.") and the field itself reverts to the plain `<input>` text box, so the admin can still type a model name manually and save. This matches the existing form's tolerance for the backend being temporarily unreachable — the page never blocks saving because a convenience feature failed.

## Testing

**Backend:**
- `listOllamaModels` unit tests (mocked `fetch`): success maps `body.models[].name` to a string array; non-OK response throws; network error throws; timeout throws.
- Route tests for `GET /api/admin/llm-settings/ollama-models`: 200 with a model list on success; 400 when `baseUrl` is missing; 502 when the Ollama call fails; 401/403 when not authenticated / not admin (matching the existing auth test pattern for sibling routes).

**Frontend** (extends `frontend/tests/admin-llm-settings.test.tsx`):
- Selecting `ollama` as provider with an existing saved `baseUrl` triggers the models fetch and renders a populated `<select>`.
- A failed or empty-list fetch shows the error message and falls back to the plain text `<input>` for Model.
- Non-Ollama providers are unaffected — Model stays a plain text input, no fetch fires.
