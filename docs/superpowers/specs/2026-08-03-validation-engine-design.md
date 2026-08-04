# Validation Engine (Java) — Design

> Subsystem #2 of the platform (see `PLANO_MVP.md`). Builds the standalone YAML rule engine that executes API challenges. Does **not** integrate with the Node backend's submission flow yet — that's subsystem #3. This engine is testable entirely on its own, via its own HTTP API and test suite.

## Goal

Given a challenge's YAML spec and a candidate's API base URL, run a sequence of HTTP checks against that URL, score the result, and report it back via a webhook — safely (no SSRF), deterministically, and without ever executing candidate-supplied code.

## Scope (v1)

Covers 4 assertion categories, matching the Foundation-era decision to defer the heavier ones:

- **CRUD** — create/read/update/delete flows, with checks chained by response state.
- **Contract** — response conformance to a bundled OpenAPI spec.
- **Status/headers** — status codes, header presence/value/pattern.
- **Basic auth** — JWT claim checks, rejection of missing/malformed/expired tokens.

Explicitly out of scope for v1 (per the Foundation-era plan): offensive security payloads (SQLi/XSS/mass assignment), load/stress testing, chaos/resilience injection (circuit breaker, retry, timeout simulation), and concurrency/race-condition testing. These need their own execution subsystems (load generator, chaos injector) and are v2 engine work.

## Architecture

New Maven module at the repo root, sibling to `backend/` and `frontend/`:

```
validation-engine/
  pom.xml
  src/main/java/com/practiceplatform/validationengine/
    ValidationEngineApplication.java
    web/
      RunController.java          — POST /runs
      RunRequest.java, RunAccepted.java
    engine/
      ChallengeSpec.java          — parsed YAML model (checks, metadata)
      CheckSpec.java              — one check: request template + expectations + points
      StepExecutor.java           — runs checks in order, holds step history
      StepResult.java             — one executed check's outcome (request sent, response, per-assertion results)
      TemplateResolver.java       — resolves {{steps[i].response...}} references
      ScoreCalculator.java        — sums points, computes percentage
      RunResult.java              — final payload posted to the webhook
      WebhookNotifier.java        — POSTs RunResult to the caller-supplied webhookUrl
    http/
      SsrfGuardedHttpClient.java  — wraps java.net.http.HttpClient, manual redirect handling
      SsrfGuard.java              — hostname/IP validation against blocked ranges
    assertions/
      Assertion.java              — interface: evaluate(StepResult) -> AssertionResult
      StatusAssertion.java
      JsonAssertion.java          — partial/lenient JSON match
      JsonSchemaAssertion.java
      HeaderAssertion.java
      JwtClaimsAssertion.java     — decodes JWT payload, no signature verification
      OpenApiAssertion.java
    yaml/
      ChallengeYamlParser.java    — Jackson YAML -> ChallengeSpec
  src/test/java/... (mirrors main)
  src/test/resources/
    challenges/*.yaml             — fixture challenges, one per category minimum
    openapi/*.yaml                — fixture OpenAPI specs for contract-category fixtures
```

**Stack:** Java 21, Spring Boot 3.x, Maven. `jackson-dataformat-yaml` for parsing, `org.everit-org.json-schema` or `networknt/json-schema-validator` for JSON Schema checks (final pick made during implementation planning), `atlassian-oai-validator` (or `swagger-request-validator`) for OpenAPI conformance, JUnit 5 + Spring Boot Test for testing.

## YAML Challenge Grammar

```yaml
id: todo-api-crud
title: "Build a Todo CRUD API"
category: crud
checks:
  - name: "POST /todos creates a todo"
    request:
      method: POST
      path: /todos
      headers:
        Content-Type: application/json
      body:
        title: "Buy milk"
    expect:
      status: 201
      json:
        title: "Buy milk"
        completed: false
      headers:
        Location: exists
    points: 10

  - name: "GET /todos/{id} returns the created todo"
    request:
      method: GET
      path: "/todos/{{steps[0].response.json.id}}"
    expect:
      status: 200
      json:
        title: "Buy milk"
    points: 10

  - name: "DELETE /todos/{id} removes it"
    request:
      method: DELETE
      path: "/todos/{{steps[0].response.json.id}}"
    expect:
      status: 204
    points: 5
```

Auth-category example (login step, then a chained authenticated request, then a static bad-token request):

```yaml
id: jwt-auth-basics
title: "JWT-protected profile endpoint"
category: auth
checks:
  - name: "POST /login returns a token"
    request:
      method: POST
      path: /login
      body: { username: "test-user", password: "test-pass" }
    expect:
      status: 200
      json: { token: exists }
    points: 5

  - name: "GET /profile with valid token succeeds"
    request:
      method: GET
      path: /profile
      headers:
        Authorization: "Bearer {{steps[0].response.json.token}}"
    expect:
      status: 200
      jwtClaims:
        # asserted against the token FROM steps[0], not a response — see
        # "Assertion Types" below for how jwtClaims picks its source
        sub: exists
    points: 10

  - name: "GET /profile with no token is rejected"
    request:
      method: GET
      path: /profile
    expect:
      status: 401
    points: 5

  - name: "GET /profile with malformed token is rejected"
    request:
      method: GET
      path: /profile
      headers:
        Authorization: "Bearer not-a-real-token"
    expect:
      status: 401
    points: 5
```

### Chaining semantics

- Checks execute strictly in YAML order, one at a time (v1 has no parallel/branching execution).
- Every executed check's full result (request sent, response status/headers/body) is appended to an ordered `steps` list, regardless of pass/fail — so a later check can still reference an earlier check's response even if that earlier check's *assertions* failed (only a hard request error — timeout, connection refused, DNS failure — makes a step's response unavailable).
- `{{steps[i].response.<path>}}` resolves against the *parsed* response: `.status`, `.headers.<Name>`, `.json.<dotted.path>`. Resolution failure (bad index, missing field, non-JSON body when `.json` is used) marks the *current* check `skipped` with a clear reason — it does not throw and does not stop the run.
- Template resolution happens in `request.path`, `request.headers.*`, and `request.body.*` (recursively for nested body fields).

## Assertion Types (v1)

| Key | Behavior |
|---|---|
| `status` | Exact integer match against response status code. |
| `json` | Lenient/partial deep match: every key in the `expect.json` block must be present with a matching value in the response body; extra response fields are ignored. `exists` as a value means "key present, any value." |
| `jsonSchema` | Path to a JSON Schema file (bundled alongside the challenge YAML, same directory) — response body validated against it. |
| `headers` | Map of header name → `exists`, an exact string, or a `regex:<pattern>` value. |
| `jwtClaims` | Decodes a JWT's payload (base64url, **no signature verification** — the engine doesn't hold the candidate's signing key) and asserts claim presence/values. Source defaults to the current check's own request `Authorization` header; when absent there, resolves from the most recent prior step's `response.json.token`-shaped field (exact resolution rule finalized during implementation — flag if the two-source lookup feels too implicit and you'd rather it be explicit in the YAML). |
| `matchesOpenApi` | Boolean; validates the (request, response) pair against the operation matching `request.path`/`method` in the challenge's bundled OpenAPI spec (`openapiSpec: <relative-path>` at the challenge's top level). |

Deliberately excluded from v1 (see Scope): payload-injection assertions, timing/latency assertions, concurrency assertions.

## SSRF Guard

`SsrfGuard` is a small, independently unit-tested class:

- Resolves the target hostname via `InetAddress.getAllByName`, rejects if **any** resolved address falls in a blocked range: loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16` — covers the cloud metadata endpoint, `fe80::/10`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and unique-local IPv6 (`fc00::/7`).
- `SsrfGuardedHttpClient` wraps `java.net.http.HttpClient` with `redirect(NEVER)` and manually inspects 3xx responses: re-runs the guard against the `Location` header's host before following, up to a configured max-hop count (default 5). A redirect into a blocked range aborts the check with a clear "blocked target" reason, not a generic error.
- Per-request connect/read timeouts (default 5s each) — a hung candidate API fails its own check instead of hanging the run.

## Scoring

- Every check carries `points` (author-assigned in the YAML).
- A check "passes" only if **all** its `expect` assertions pass; otherwise it's "failed" (or "skipped" per the chaining rule above).
- `RunResult.score = round(100 * sum(points of passed checks) / sum(points of all checks))`.
- `RunResult` also carries the raw pass/fail/skipped counts and a per-check breakdown (name, status, points earned, assertion-level detail) — the percentage is derived, not the only signal, so a future UI/AI-feedback layer has enough to work with.

## API (this module's own surface)

```
POST /runs
{
  "jobId": "string",          // caller-supplied correlation id, echoed back
  "targetUrl": "https://candidate-api.example.com",
  "challengeYaml": "id: todo-api-crud\ntitle: ...",   // raw YAML text
  "webhookUrl": "https://caller.example.com/webhook"  // where the result is POSTed when done
}
```

Response: `202 Accepted`, body `{ "jobId": "...", "status": "accepted" }` — immediately, before execution starts.

On completion (success or engine-level failure — e.g. YAML failed to parse), the engine `POST`s to `webhookUrl`:

```
{
  "jobId": "string",
  "status": "completed" | "error",
  "score": 85,                     // 0-100, omitted if status is "error"
  "checks": [
    { "name": "...", "status": "passed" | "failed" | "skipped", "points": 10, "pointsEarned": 10, "assertions": [ { "type": "status", "passed": true, "detail": "..." } ] }
  ],
  "error": "..."                   // present only when status is "error"
}
```

This shape is deliberately the same one subsystem #3 (Node integration) will use for real — Node will supply its actual webhook endpoint as `webhookUrl` when it starts calling this API for real. Nothing here is throwaway.

## Testing Strategy

- `SsrfGuard`: pure unit tests against IP-range logic, no network calls.
- Engine end-to-end: each fixture challenge (`src/test/resources/challenges/*.yaml`) is run against a small embedded test HTTP server (`com.sun.net.httpserver.HttpServer` or WireMock — final pick during implementation) standing in for "the candidate's API," configured with both a known-good and a known-bad response set per test, asserting the resulting score and per-check detail.
- Webhook delivery: tests supply a `webhookUrl` pointing at a local test server and assert the callback body.
- At least one fixture per category (CRUD, contract, status/headers, auth) — 4 fixtures minimum, growing toward the 5-8 real launch challenges as content is authored (content authoring itself is out of scope for this subsystem's plan; these are engine-proving fixtures, not the final catalog).

## Open Items for the Implementation Plan

These are implementation-detail choices intentionally left for `writing-plans` to pin down with real code, not open design questions:

- Exact JSON Schema validation library (`networknt/json-schema-validator` vs `everit-org/json-schema`).
- Exact OpenAPI validation library (`atlassian-oai-validator` vs `swagger-request-validator`).
- `jwtClaims`' two-source lookup rule (current check's own header vs. falling back to a prior step) — implement the simpler explicit form if the implicit fallback proves confusing in practice.
- Whether the embedded test HTTP server for engine tests is JDK's built-in `HttpServer` or WireMock.
