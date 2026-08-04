# Validation Engine (Java) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone Java validation engine described in `docs/superpowers/specs/2026-08-03-validation-engine-design.md`: a Spring Boot service that accepts a YAML challenge spec + a candidate API URL via `POST /runs`, runs the challenge's checks against that URL safely (SSRF-guarded), scores the result, and reports it back via webhook.

**Architecture:** New Maven module `validation-engine/` at the repo root, sibling to `backend/` and `frontend/`. Single Spring Boot application with four internal layers: `yaml` (parses the challenge YAML into a model), `engine` (orchestrates check execution, template resolution, scoring, webhook delivery), `assertions` (one class per `expect.*` assertion type), `http` (the SSRF-guarded HTTP client used only for candidate-target requests). `POST /runs` returns `202 Accepted` immediately and processes in a background virtual thread; the result is POSTed to the caller-supplied `webhookUrl` on completion. This plan does not integrate with the Node backend — that's a separate subsystem.

**Tech Stack:** Java 21, Spring Boot 3.3.5, Maven. `jackson-dataformat-yaml` for YAML parsing. `com.networknt:json-schema-validator` for `jsonSchema` assertions. `com.atlassian.oai:swagger-request-validator-core` for `matchesOpenApi` assertions. JUnit 5 + Mockito (via `spring-boot-starter-test`) for tests. JDK's built-in `com.sun.net.httpserver.HttpServer` stands in for "the candidate's API" and for webhook receivers in tests (per the design doc's Open Items, this plan picks the JDK server over WireMock to avoid an extra test dependency).

## Global Constraints

- No SSRF: every request to a candidate-supplied `targetUrl` goes through `SsrfGuardedHttpClient`, which blocks loopback, link-local, private, and unique-local-IPv6 ranges and re-validates on every redirect hop (design doc, "SSRF Guard").
- Never execute candidate-supplied code — the engine only ever acts as an HTTP client against the candidate's URL (design doc, "Goal").
- `RunResult`'s webhook JSON shape is locked to the design doc's "API" section verbatim — subsystem #3 (Node integration) will consume this shape for real, so field names/nesting are not negotiable in this plan.
- Checks execute strictly in YAML order, one at a time — no parallel/branching execution in v1 (design doc, "Chaining semantics").
- Per-request connect/read timeouts default to 5s each; max redirect hops defaults to 5 (design doc, "SSRF Guard").
- `jwtClaims` decodes the JWT payload only — no signature verification (design doc, "Assertion Types").
- **Decision (Open Item resolved):** `jwtClaims`'s source is the *current check's own request* `Authorization` header only — the simpler explicit form, not the implicit prior-step fallback. The design doc's own auth example never needs the fallback (the token is always template-resolved into the current request's `Authorization` header first), so the simpler form is sufficient.
- **Decision (Open Item resolved):** JSON Schema library is `com.networknt:json-schema-validator`; OpenAPI validation library is `com.atlassian.oai:swagger-request-validator-core`; the embedded test HTTP server is JDK's `com.sun.net.httpserver.HttpServer`.
- **Scope note:** the design doc's `POST /runs` body carries `challengeYaml` as raw text but has no field for a schema/OpenAPI-spec *file*, even though `jsonSchema`/`openapiSpec` reference sibling files "bundled alongside the challenge YAML." How those bundle files travel over the wire is a subsystem #3 (Node integration) concern, explicitly out of scope per the design doc's own framing. This plan resolves `jsonSchema`/`openapiSpec` paths as classpath resources (rooted at `/challenges/` and `/` respectively) — sufficient for the engine's own standalone test suite, which is this subsystem's whole deliverable.

---

## File Structure

```
validation-engine/
  pom.xml
  src/main/java/com/practiceplatform/validationengine/
    ValidationEngineApplication.java
    web/
      RunController.java
      RunRequest.java
      RunAccepted.java
      EngineConfig.java                 — Spring @Bean wiring (not in original design doc list; needed for DI)
    engine/
      ChallengeSpec.java
      CheckSpec.java                    — includes nested RequestSpec, ExpectSpec
      StepExecutor.java
      StepResult.java                   — includes nested ResolvedRequest, Response
      TemplateResolver.java             — includes nested ResolutionException
      ScoreCalculator.java              — includes nested AssertionDto, CheckResult, ScoredRun
      RunResult.java
      WebhookNotifier.java
    http/
      SsrfGuardedHttpClient.java        — includes nested RawResponse, BlockedTargetException
      SsrfGuard.java                    — includes nested BlockedHostException
    assertions/
      Assertion.java
      AssertionResult.java              — not in original design doc list; return type of Assertion.evaluate
      AssertionFactory.java             — not in original design doc list; builds Assertion list from ExpectSpec
      StatusAssertion.java
      JsonAssertion.java
      HeaderAssertion.java
      JwtClaimsAssertion.java
      JsonSchemaAssertion.java
      OpenApiAssertion.java
    yaml/
      ChallengeYamlParser.java
  src/test/java/com/practiceplatform/validationengine/  (mirrors main, plus:)
    http/AllowAllSsrfGuard.java         — test double: SsrfGuard subclass that never blocks, for tests hitting an embedded local "candidate" server
  src/test/resources/
    challenges/
      todo-api-crud.yaml
      todo-schema.json
      todo-api-contract.yaml
      status-headers-basics.yaml
      jwt-auth-basics.yaml
    openapi/
      todo-api.yaml
```

---

## Task 1: Maven scaffold + Spring Boot health check

**Files:**
- Create: `validation-engine/pom.xml`
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/ValidationEngineApplication.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/ValidationEngineApplicationTests.java`

**Interfaces:**
- Produces: a bootable Spring Boot app; every later task's classes live under `com.practiceplatform.validationengine.*` and are picked up by this app's component scan.

- [ ] **Step 1: Create the module directory structure**

```bash
mkdir -p validation-engine/src/main/java/com/practiceplatform/validationengine
mkdir -p validation-engine/src/test/java/com/practiceplatform/validationengine
mkdir -p validation-engine/src/test/resources/challenges
mkdir -p validation-engine/src/test/resources/openapi
```

- [ ] **Step 2: Write the failing test**

`validation-engine/src/test/java/com/practiceplatform/validationengine/ValidationEngineApplicationTests.java`:

```java
package com.practiceplatform.validationengine;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class ValidationEngineApplicationTests {

    @Test
    void contextLoads() {
    }
}
```

- [ ] **Step 3: Write the pom.xml and application entry point**

`validation-engine/pom.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.3.5</version>
        <relativePath/>
    </parent>

    <groupId>com.practiceplatform</groupId>
    <artifactId>validation-engine</artifactId>
    <version>0.1.0</version>
    <packaging>jar</packaging>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>com.fasterxml.jackson.dataformat</groupId>
            <artifactId>jackson-dataformat-yaml</artifactId>
        </dependency>
        <dependency>
            <groupId>com.networknt</groupId>
            <artifactId>json-schema-validator</artifactId>
            <version>1.5.1</version>
        </dependency>
        <dependency>
            <groupId>com.atlassian.oai</groupId>
            <artifactId>swagger-request-validator-core</artifactId>
            <version>2.43.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/ValidationEngineApplication.java`:

```java
package com.practiceplatform.validationengine;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ValidationEngineApplication {

    public static void main(String[] args) {
        SpringApplication.run(ValidationEngineApplication.class, args);
    }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd validation-engine && mvn -q test
```

Expected: `BUILD SUCCESS`, `ValidationEngineApplicationTests` passes.

- [ ] **Step 5: Commit**

```bash
git add validation-engine/pom.xml validation-engine/src
git commit -m "feat: scaffold validation-engine Maven module"
```

---

## Task 2: Challenge YAML model + parser

**Files:**
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/engine/ChallengeSpec.java`
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/engine/CheckSpec.java`
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/yaml/ChallengeYamlParser.java`
- Create: `validation-engine/src/test/resources/challenges/todo-api-crud.yaml`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/yaml/ChallengeYamlParserTest.java`

**Interfaces:**
- Produces: `ChallengeSpec` (fields: `id`, `title`, `category`, `openapiSpec`, `checks: List<CheckSpec>`) and `CheckSpec` (fields: `name`, `points`, `request: CheckSpec.RequestSpec`, `expect: CheckSpec.ExpectSpec`) — every later task reads challenge data through these two classes. `ChallengeYamlParser.parse(String yamlText): ChallengeSpec` — used by `RunController` (Task 13).

- [ ] **Step 1: Write the CRUD fixture YAML and the failing test**

`validation-engine/src/test/resources/challenges/todo-api-crud.yaml`:

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

`validation-engine/src/test/java/com/practiceplatform/validationengine/yaml/ChallengeYamlParserTest.java`:

```java
package com.practiceplatform.validationengine.yaml;

import com.practiceplatform.validationengine.engine.ChallengeSpec;
import com.practiceplatform.validationengine.engine.CheckSpec;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class ChallengeYamlParserTest {

    @Test
    void parsesCrudChallenge() throws IOException {
        String yaml = Files.readString(Path.of("src/test/resources/challenges/todo-api-crud.yaml"));

        ChallengeSpec spec = new ChallengeYamlParser().parse(yaml);

        assertEquals("todo-api-crud", spec.getId());
        assertEquals("crud", spec.getCategory());
        assertNull(spec.getOpenapiSpec());
        assertEquals(3, spec.getChecks().size());

        CheckSpec first = spec.getChecks().get(0);
        assertEquals("POST /todos creates a todo", first.getName());
        assertEquals(10, first.getPoints());
        assertEquals("POST", first.getRequest().getMethod());
        assertEquals("/todos", first.getRequest().getPath());
        assertEquals("application/json", first.getRequest().getHeaders().get("Content-Type"));
        assertEquals("Buy milk", first.getRequest().getBody().get("title"));
        assertEquals(201, first.getExpect().getStatus());
        assertEquals(false, first.getExpect().getJson().get("completed"));
        assertEquals("exists", first.getExpect().getHeaders().get("Location"));

        CheckSpec second = spec.getChecks().get(1);
        assertEquals("/todos/{{steps[0].response.json.id}}", second.getRequest().getPath());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd validation-engine && mvn -q test -Dtest=ChallengeYamlParserTest
```

Expected: FAIL — `ChallengeSpec`, `CheckSpec`, `ChallengeYamlParser` do not exist.

- [ ] **Step 3: Write the models and parser**

`validation-engine/src/main/java/com/practiceplatform/validationengine/engine/ChallengeSpec.java`:

```java
package com.practiceplatform.validationengine.engine;

import java.util.List;

public class ChallengeSpec {
    private String id;
    private String title;
    private String category;
    private String openapiSpec;
    private List<CheckSpec> checks;

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getCategory() { return category; }
    public void setCategory(String category) { this.category = category; }
    public String getOpenapiSpec() { return openapiSpec; }
    public void setOpenapiSpec(String openapiSpec) { this.openapiSpec = openapiSpec; }
    public List<CheckSpec> getChecks() { return checks; }
    public void setChecks(List<CheckSpec> checks) { this.checks = checks; }
}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/engine/CheckSpec.java`:

```java
package com.practiceplatform.validationengine.engine;

import java.util.Map;

public class CheckSpec {
    private String name;
    private RequestSpec request;
    private ExpectSpec expect;
    private int points;

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public RequestSpec getRequest() { return request; }
    public void setRequest(RequestSpec request) { this.request = request; }
    public ExpectSpec getExpect() { return expect; }
    public void setExpect(ExpectSpec expect) { this.expect = expect; }
    public int getPoints() { return points; }
    public void setPoints(int points) { this.points = points; }

    public static class RequestSpec {
        private String method;
        private String path;
        private Map<String, String> headers;
        private Object body;

        public String getMethod() { return method; }
        public void setMethod(String method) { this.method = method; }
        public String getPath() { return path; }
        public void setPath(String path) { this.path = path; }
        public Map<String, String> getHeaders() { return headers; }
        public void setHeaders(Map<String, String> headers) { this.headers = headers; }
        public Object getBody() { return body; }
        public void setBody(Object body) { this.body = body; }
    }

    public static class ExpectSpec {
        private Integer status;
        private Map<String, Object> json;
        private Map<String, String> headers;
        private String jsonSchema;
        private Map<String, Object> jwtClaims;
        private Boolean matchesOpenApi;

        public Integer getStatus() { return status; }
        public void setStatus(Integer status) { this.status = status; }
        public Map<String, Object> getJson() { return json; }
        public void setJson(Map<String, Object> json) { this.json = json; }
        public Map<String, String> getHeaders() { return headers; }
        public void setHeaders(Map<String, String> headers) { this.headers = headers; }
        public String getJsonSchema() { return jsonSchema; }
        public void setJsonSchema(String jsonSchema) { this.jsonSchema = jsonSchema; }
        public Map<String, Object> getJwtClaims() { return jwtClaims; }
        public void setJwtClaims(Map<String, Object> jwtClaims) { this.jwtClaims = jwtClaims; }
        public Boolean getMatchesOpenApi() { return matchesOpenApi; }
        public void setMatchesOpenApi(Boolean matchesOpenApi) { this.matchesOpenApi = matchesOpenApi; }
    }
}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/yaml/ChallengeYamlParser.java`:

```java
package com.practiceplatform.validationengine.yaml;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.dataformat.yaml.YAMLMapper;
import com.practiceplatform.validationengine.engine.ChallengeSpec;

import java.io.IOException;

public class ChallengeYamlParser {

    private final YAMLMapper mapper;

    public ChallengeYamlParser() {
        this.mapper = YAMLMapper.builder()
                .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .build();
    }

    public ChallengeSpec parse(String yamlText) throws IOException {
        return mapper.readValue(yamlText, ChallengeSpec.class);
    }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd validation-engine && mvn -q test -Dtest=ChallengeYamlParserTest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add validation-engine/src/main/java/com/practiceplatform/validationengine/engine/ChallengeSpec.java \
        validation-engine/src/main/java/com/practiceplatform/validationengine/engine/CheckSpec.java \
        validation-engine/src/main/java/com/practiceplatform/validationengine/yaml/ChallengeYamlParser.java \
        validation-engine/src/test/resources/challenges/todo-api-crud.yaml \
        validation-engine/src/test/java/com/practiceplatform/validationengine/yaml/ChallengeYamlParserTest.java
git commit -m "feat: parse challenge YAML into ChallengeSpec/CheckSpec"
```

---

## Task 3: SsrfGuard

**Files:**
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/http/SsrfGuard.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/http/SsrfGuardTest.java`

**Interfaces:**
- Produces: `SsrfGuard.check(String host): void` throws `SsrfGuard.BlockedHostException` — used by `SsrfGuardedHttpClient` (Task 4).

- [ ] **Step 1: Write the failing test**

```java
package com.practiceplatform.validationengine.http;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

class SsrfGuardTest {

    private final SsrfGuard guard = new SsrfGuard();

    @ParameterizedTest
    @ValueSource(strings = {
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.5",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "::1",
            "fc00::1",
            "fd12:3456::1"
    })
    void blocksAddressesInReservedRanges(String ip) {
        assertThrows(SsrfGuard.BlockedHostException.class, () -> guard.check(ip));
    }

    @ParameterizedTest
    @ValueSource(strings = {"8.8.8.8", "1.1.1.1", "93.184.216.34"})
    void allowsPublicAddresses(String ip) {
        assertDoesNotThrow(() -> guard.check(ip));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd validation-engine && mvn -q test -Dtest=SsrfGuardTest
```

Expected: FAIL — `SsrfGuard` does not exist.

- [ ] **Step 3: Write the implementation**

```java
package com.practiceplatform.validationengine.http;

import java.net.InetAddress;
import java.net.UnknownHostException;

public class SsrfGuard {

    public static class BlockedHostException extends Exception {
        public BlockedHostException(String message) { super(message); }
    }

    public void check(String host) throws BlockedHostException, UnknownHostException {
        InetAddress[] addresses = InetAddress.getAllByName(host);
        for (InetAddress address : addresses) {
            if (isBlocked(address)) {
                throw new BlockedHostException(
                        "blocked target: " + host + " resolves to " + address.getHostAddress());
            }
        }
    }

    protected boolean isBlocked(InetAddress address) {
        if (address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress()) {
            return true;
        }
        byte[] bytes = address.getAddress();
        return bytes.length == 16 && (bytes[0] & 0xFE) == 0xFC;
    }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd validation-engine && mvn -q test -Dtest=SsrfGuardTest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add validation-engine/src/main/java/com/practiceplatform/validationengine/http/SsrfGuard.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/http/SsrfGuardTest.java
git commit -m "feat: block SSRF-sensitive IP ranges in SsrfGuard"
```

---

## Task 4: SsrfGuardedHttpClient

**Files:**
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/http/SsrfGuardedHttpClient.java`
- Create: `validation-engine/src/test/java/com/practiceplatform/validationengine/http/AllowAllSsrfGuard.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/http/SsrfGuardedHttpClientTest.java`

**Interfaces:**
- Consumes: `SsrfGuard.check(String host)` (Task 3).
- Produces: `SsrfGuardedHttpClient.send(String method, String url, Map<String,String> headers, String body): RawResponse` — used by `StepExecutor` (Task 7). `RawResponse(int status, Map<String,String> headers, String body)`. `AllowAllSsrfGuard` — test double reused by Tasks 7, 13, 14 to let tests hit an embedded local "candidate" server.

- [ ] **Step 1: Write the test double and the failing test**

`validation-engine/src/test/java/com/practiceplatform/validationengine/http/AllowAllSsrfGuard.java`:

```java
package com.practiceplatform.validationengine.http;

import java.net.InetAddress;

public class AllowAllSsrfGuard extends SsrfGuard {
    @Override
    protected boolean isBlocked(InetAddress address) {
        return false;
    }
}
```

`validation-engine/src/test/java/com/practiceplatform/validationengine/http/SsrfGuardedHttpClientTest.java`:

```java
package com.practiceplatform.validationengine.http;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;

class SsrfGuardedHttpClientTest {

    private HttpServer server;
    private int port;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        port = server.getAddress().getPort();
        server.start();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    @Test
    void abortsWhenGuardBlocksTarget() throws Exception {
        SsrfGuard blockingGuard = mock(SsrfGuard.class);
        doThrow(new SsrfGuard.BlockedHostException("blocked target: localhost"))
                .when(blockingGuard).check("localhost");

        SsrfGuardedHttpClient client = new SsrfGuardedHttpClient(blockingGuard);

        SsrfGuardedHttpClient.BlockedTargetException ex = assertThrows(
                SsrfGuardedHttpClient.BlockedTargetException.class,
                () -> client.send("GET", "http://localhost:" + port + "/", Map.of(), null));
        assertTrue(ex.getMessage().contains("blocked target"));
    }

    @Test
    void followsRedirectChainToFinalResponse() throws Exception {
        server.createContext("/start", exchange -> {
            exchange.getResponseHeaders().add("Location", "/end");
            exchange.sendResponseHeaders(302, -1);
            exchange.close();
        });
        server.createContext("/end", exchange -> {
            byte[] body = "{\"ok\":true}".getBytes();
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });

        SsrfGuardedHttpClient client = new SsrfGuardedHttpClient(new AllowAllSsrfGuard());
        SsrfGuardedHttpClient.RawResponse response =
                client.send("GET", "http://localhost:" + port + "/start", Map.of(), null);

        assertEquals(200, response.status());
        assertEquals("{\"ok\":true}", response.body());
    }

    @Test
    void abortsAfterExceedingMaxRedirects() {
        server.createContext("/loop", exchange -> {
            exchange.getResponseHeaders().add("Location", "/loop");
            exchange.sendResponseHeaders(302, -1);
            exchange.close();
        });

        SsrfGuardedHttpClient client = new SsrfGuardedHttpClient(
                new AllowAllSsrfGuard(), 2, Duration.ofSeconds(2), Duration.ofSeconds(2));

        IOException ex = assertThrows(IOException.class,
                () -> client.send("GET", "http://localhost:" + port + "/loop", Map.of(), null));
        assertTrue(ex.getMessage().contains("too many redirects"));
    }

    @Test
    void abortsOnReadTimeout() {
        server.createContext("/slow", exchange -> {
            try {
                TimeUnit.SECONDS.sleep(3);
            } catch (InterruptedException ignored) {
            }
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });

        SsrfGuardedHttpClient client = new SsrfGuardedHttpClient(
                new AllowAllSsrfGuard(), 5, Duration.ofSeconds(2), Duration.ofMillis(300));

        assertThrows(HttpTimeoutException.class,
                () -> client.send("GET", "http://localhost:" + port + "/slow", Map.of(), null));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd validation-engine && mvn -q test -Dtest=SsrfGuardedHttpClientTest
```

Expected: FAIL — `SsrfGuardedHttpClient` does not exist.

- [ ] **Step 3: Write the implementation**

```java
package com.practiceplatform.validationengine.http;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

public class SsrfGuardedHttpClient {

    public record RawResponse(int status, Map<String, String> headers, String body) {}

    public static class BlockedTargetException extends IOException {
        public BlockedTargetException(String message) { super(message); }
    }

    private final SsrfGuard guard;
    private final int maxRedirects;
    private final Duration connectTimeout;
    private final Duration readTimeout;

    public SsrfGuardedHttpClient(SsrfGuard guard) {
        this(guard, 5, Duration.ofSeconds(5), Duration.ofSeconds(5));
    }

    public SsrfGuardedHttpClient(SsrfGuard guard, int maxRedirects, Duration connectTimeout, Duration readTimeout) {
        this.guard = guard;
        this.maxRedirects = maxRedirects;
        this.connectTimeout = connectTimeout;
        this.readTimeout = readTimeout;
    }

    public RawResponse send(String method, String url, Map<String, String> headers, String body)
            throws IOException, InterruptedException {
        String currentUrl = url;
        for (int hop = 0; hop <= maxRedirects; hop++) {
            URI uri = URI.create(currentUrl);
            try {
                guard.check(uri.getHost());
            } catch (SsrfGuard.BlockedHostException e) {
                throw new BlockedTargetException(e.getMessage());
            }

            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(connectTimeout)
                    .followRedirects(HttpClient.Redirect.NEVER)
                    .build();

            HttpRequest.Builder requestBuilder = HttpRequest.newBuilder(uri)
                    .timeout(readTimeout)
                    .method(method, body == null
                            ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofString(body));
            headers.forEach(requestBuilder::header);

            HttpResponse<String> response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString());

            if (isRedirect(response.statusCode())) {
                String location = response.headers().firstValue("Location")
                        .orElseThrow(() -> new IOException("redirect with no Location header"));
                currentUrl = uri.resolve(location).toString();
                continue;
            }

            return new RawResponse(response.statusCode(), flattenHeaders(response), response.body());
        }
        throw new IOException("too many redirects (max " + maxRedirects + ")");
    }

    private boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    private Map<String, String> flattenHeaders(HttpResponse<String> response) {
        Map<String, String> flattened = new LinkedHashMap<>();
        response.headers().map().forEach((name, values) -> {
            if (!values.isEmpty()) flattened.put(name, values.get(0));
        });
        return flattened;
    }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd validation-engine && mvn -q test -Dtest=SsrfGuardedHttpClientTest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add validation-engine/src/main/java/com/practiceplatform/validationengine/http/SsrfGuardedHttpClient.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/http/AllowAllSsrfGuard.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/http/SsrfGuardedHttpClientTest.java
git commit -m "feat: SSRF-guarded HTTP client with redirect revalidation and timeouts"
```

---

## Task 5: StepResult + Assertion interface + Status/Header/Json assertions

**Files:**
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/engine/StepResult.java`
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/AssertionResult.java`
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/Assertion.java`
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/StatusAssertion.java`
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/HeaderAssertion.java`
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/JsonAssertion.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/StatusAssertionTest.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/HeaderAssertionTest.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/JsonAssertionTest.java`

**Interfaces:**
- Produces: `StepResult.forExecuted(String checkName, int points, ResolvedRequest request, Response response): StepResult`, `StepResult.skipped(String, int, String reason)`, `StepResult.error(String, int, String reason)`, `StepResult.addAssertionResult(AssertionResult)`, `StepResult.finalizeStatus()`, `StepResult.checkName()/points()/request()/response()/assertions()/status()/reason()`. `StepResult.ResolvedRequest(String method, String path, Map<String,String> headers, Object body)`. `StepResult.Response(int status, Map<String,String> headers, String bodyRaw)` with `.status()/.header(String)/.bodyRaw()/.json(): JsonNode`. `AssertionResult(String type, boolean passed, String detail)`. `Assertion.evaluate(StepResult): AssertionResult` — every assertion class (this task and Tasks 8, 9, 10) implements this. Used by `StepExecutor` (Task 7) and `AssertionFactory` (Task 7).

- [ ] **Step 1: Write the failing tests**

`validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/StatusAssertionTest.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StatusAssertionTest {

    @Test
    void passesWhenStatusMatches() {
        StepResult step = StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(200, Map.of(), "{}"));

        assertTrue(new StatusAssertion(200).evaluate(step).passed());
    }

    @Test
    void failsWhenStatusDiffers() {
        StepResult step = StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(404, Map.of(), "{}"));

        assertFalse(new StatusAssertion(200).evaluate(step).passed());
    }
}
```

`validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/HeaderAssertionTest.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HeaderAssertionTest {

    private StepResult stepWithHeaders(Map<String, String> headers) {
        return StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(200, headers, "{}"));
    }

    @Test
    void passesWhenHeaderExists() {
        StepResult step = stepWithHeaders(Map.of("Location", "/todos/1"));
        assertTrue(new HeaderAssertion(Map.of("Location", "exists")).evaluate(step).passed());
    }

    @Test
    void failsWhenHeaderMissing() {
        StepResult step = stepWithHeaders(Map.of());
        assertFalse(new HeaderAssertion(Map.of("Location", "exists")).evaluate(step).passed());
    }

    @Test
    void passesWhenHeaderMatchesRegex() {
        StepResult step = stepWithHeaders(Map.of("Content-Type", "application/json;charset=UTF-8"));
        assertTrue(new HeaderAssertion(Map.of("Content-Type", "regex:application/json.*"))
                .evaluate(step).passed());
    }

    @Test
    void failsWhenHeaderValueDiffers() {
        StepResult step = stepWithHeaders(Map.of("X-Service", "other-api"));
        assertFalse(new HeaderAssertion(Map.of("X-Service", "todo-api")).evaluate(step).passed());
    }
}
```

`validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/JsonAssertionTest.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JsonAssertionTest {

    private StepResult stepWithBody(String body) {
        return StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(200, Map.of(), body));
    }

    @Test
    void passesOnPartialMatchIgnoringExtraFields() {
        StepResult step = stepWithBody("{\"title\":\"Buy milk\",\"completed\":false,\"id\":\"1\"}");
        assertTrue(new JsonAssertion(Map.of("title", "Buy milk", "completed", false))
                .evaluate(step).passed());
    }

    @Test
    void existsSentinelOnlyChecksPresence() {
        StepResult step = stepWithBody("{\"id\":\"anything\"}");
        assertTrue(new JsonAssertion(Map.of("id", "exists")).evaluate(step).passed());
    }

    @Test
    void failsWhenFieldMissing() {
        StepResult step = stepWithBody("{\"title\":\"Buy milk\"}");
        assertFalse(new JsonAssertion(Map.of("completed", false)).evaluate(step).passed());
    }

    @Test
    void failsWhenBodyIsNotJson() {
        StepResult step = stepWithBody("not json");
        assertFalse(new JsonAssertion(Map.of("title", "Buy milk")).evaluate(step).passed());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd validation-engine && mvn -q test -Dtest=StatusAssertionTest,HeaderAssertionTest,JsonAssertionTest
```

Expected: FAIL — none of the classes exist yet.

- [ ] **Step 3: Write the implementation**

`validation-engine/src/main/java/com/practiceplatform/validationengine/engine/StepResult.java`:

```java
package com.practiceplatform.validationengine.engine;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.practiceplatform.validationengine.assertions.AssertionResult;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class StepResult {

    public enum Status { PASSED, FAILED, SKIPPED, ERROR }

    private static final ObjectMapper JSON = new ObjectMapper();

    private final String checkName;
    private final int points;
    private final ResolvedRequest request;
    private final Response response;
    private final List<AssertionResult> assertions = new ArrayList<>();
    private Status status;
    private final String reason;

    private StepResult(String checkName, int points, ResolvedRequest request, Response response,
                        Status status, String reason) {
        this.checkName = checkName;
        this.points = points;
        this.request = request;
        this.response = response;
        this.status = status;
        this.reason = reason;
    }

    public static StepResult forExecuted(String checkName, int points, ResolvedRequest request, Response response) {
        return new StepResult(checkName, points, request, response, null, null);
    }

    public static StepResult skipped(String checkName, int points, String reason) {
        return new StepResult(checkName, points, null, null, Status.SKIPPED, reason);
    }

    public static StepResult error(String checkName, int points, String reason) {
        return new StepResult(checkName, points, null, null, Status.ERROR, reason);
    }

    public void addAssertionResult(AssertionResult result) {
        assertions.add(result);
    }

    public void finalizeStatus() {
        this.status = assertions.stream().allMatch(AssertionResult::passed) ? Status.PASSED : Status.FAILED;
    }

    public String checkName() { return checkName; }
    public int points() { return points; }
    public ResolvedRequest request() { return request; }
    public Response response() { return response; }
    public List<AssertionResult> assertions() { return assertions; }
    public Status status() { return status; }
    public String reason() { return reason; }

    public record ResolvedRequest(String method, String path, Map<String, String> headers, Object body) {}

    public static final class Response {
        private final int status;
        private final Map<String, String> headers;
        private final String bodyRaw;
        private JsonNode cachedJson;
        private boolean jsonParsed;

        public Response(int status, Map<String, String> headers, String bodyRaw) {
            this.status = status;
            this.headers = headers;
            this.bodyRaw = bodyRaw;
        }

        public int status() { return status; }

        public String header(String name) {
            return headers.entrySet().stream()
                    .filter(e -> e.getKey().equalsIgnoreCase(name))
                    .map(Map.Entry::getValue)
                    .findFirst().orElse(null);
        }

        public String bodyRaw() { return bodyRaw; }

        public JsonNode json() throws JsonProcessingException {
            if (!jsonParsed) {
                cachedJson = (bodyRaw == null || bodyRaw.isBlank()) ? null : JSON.readTree(bodyRaw);
                jsonParsed = true;
            }
            return cachedJson;
        }
    }
}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/AssertionResult.java`:

```java
package com.practiceplatform.validationengine.assertions;

public record AssertionResult(String type, boolean passed, String detail) {}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/Assertion.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;

public interface Assertion {
    AssertionResult evaluate(StepResult step);
}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/StatusAssertion.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;

public class StatusAssertion implements Assertion {
    private final int expectedStatus;

    public StatusAssertion(int expectedStatus) { this.expectedStatus = expectedStatus; }

    @Override
    public AssertionResult evaluate(StepResult step) {
        int actual = step.response().status();
        boolean passed = actual == expectedStatus;
        String detail = passed
                ? "status is " + actual
                : "expected status " + expectedStatus + " but got " + actual;
        return new AssertionResult("status", passed, detail);
    }
}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/HeaderAssertion.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;

import java.util.Map;
import java.util.regex.Pattern;

public class HeaderAssertion implements Assertion {
    private final Map<String, String> expected;

    public HeaderAssertion(Map<String, String> expected) { this.expected = expected; }

    @Override
    public AssertionResult evaluate(StepResult step) {
        for (Map.Entry<String, String> entry : expected.entrySet()) {
            String name = entry.getKey();
            String rule = entry.getValue();
            String actual = step.response().header(name);

            if ("exists".equals(rule)) {
                if (actual == null) {
                    return new AssertionResult("headers", false, "header missing: " + name);
                }
                continue;
            }
            if (rule.startsWith("regex:")) {
                String pattern = rule.substring("regex:".length());
                if (actual == null || !Pattern.matches(pattern, actual)) {
                    return new AssertionResult("headers", false,
                            "header " + name + " did not match " + pattern + " (was: " + actual + ")");
                }
                continue;
            }
            if (!rule.equals(actual)) {
                return new AssertionResult("headers", false,
                        "header " + name + " expected " + rule + " but got " + actual);
            }
        }
        return new AssertionResult("headers", true, "all headers matched");
    }
}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/JsonAssertion.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.fasterxml.jackson.databind.JsonNode;
import com.practiceplatform.validationengine.engine.StepResult;

import java.util.Map;

public class JsonAssertion implements Assertion {
    private final Map<String, Object> expected;

    public JsonAssertion(Map<String, Object> expected) { this.expected = expected; }

    @Override
    public AssertionResult evaluate(StepResult step) {
        JsonNode actual;
        try {
            actual = step.response().json();
        } catch (Exception e) {
            return new AssertionResult("json", false, "response body is not valid JSON");
        }
        if (actual == null) {
            return new AssertionResult("json", false, "response body is empty");
        }
        String mismatch = firstMismatch(expected, actual, "");
        if (mismatch != null) {
            return new AssertionResult("json", false, mismatch);
        }
        return new AssertionResult("json", true, "response body matched expected fields");
    }

    @SuppressWarnings("unchecked")
    private String firstMismatch(Map<String, Object> expectedMap, JsonNode actual, String prefix) {
        for (Map.Entry<String, Object> entry : expectedMap.entrySet()) {
            String key = entry.getKey();
            Object expectedValue = entry.getValue();
            String fieldPath = prefix.isEmpty() ? key : prefix + "." + key;
            JsonNode actualValue = actual.get(key);

            if (actualValue == null) {
                return "field missing: " + fieldPath;
            }
            if ("exists".equals(expectedValue)) {
                continue;
            }
            if (expectedValue instanceof Map<?, ?> nestedExpected) {
                String nestedMismatch = firstMismatch((Map<String, Object>) nestedExpected, actualValue, fieldPath);
                if (nestedMismatch != null) return nestedMismatch;
                continue;
            }
            if (!matchesScalar(expectedValue, actualValue)) {
                return "field " + fieldPath + " expected " + expectedValue + " but got " + actualValue;
            }
        }
        return null;
    }

    private boolean matchesScalar(Object expectedValue, JsonNode actualValue) {
        if (expectedValue instanceof Boolean b) return actualValue.isBoolean() && actualValue.asBoolean() == b;
        if (expectedValue instanceof Number n) return actualValue.isNumber() && actualValue.asDouble() == n.doubleValue();
        return actualValue.isTextual()
                ? actualValue.asText().equals(String.valueOf(expectedValue))
                : String.valueOf(expectedValue).equals(actualValue.toString());
    }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd validation-engine && mvn -q test -Dtest=StatusAssertionTest,HeaderAssertionTest,JsonAssertionTest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add validation-engine/src/main/java/com/practiceplatform/validationengine/engine/StepResult.java \
        validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/AssertionResult.java \
        validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/Assertion.java \
        validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/StatusAssertion.java \
        validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/HeaderAssertion.java \
        validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/JsonAssertion.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/StatusAssertionTest.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/HeaderAssertionTest.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/JsonAssertionTest.java
git commit -m "feat: add StepResult model and status/header/json assertions"
```

---

## Task 6: TemplateResolver

**Files:**
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/engine/TemplateResolver.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/engine/TemplateResolverTest.java`

**Interfaces:**
- Consumes: `StepResult` (Task 5).
- Produces: `TemplateResolver.resolveString(String, List<StepResult>): String`, `.resolveHeaders(Map<String,String>, List<StepResult>): Map<String,String>`, `.resolveBody(Object, List<StepResult>): Object`, all throwing `TemplateResolver.ResolutionException` — used by `StepExecutor` (Task 7).

- [ ] **Step 1: Write the failing test**

```java
package com.practiceplatform.validationengine.engine;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class TemplateResolverTest {

    private final TemplateResolver resolver = new TemplateResolver();

    private StepResult stepWithJsonBody(String body) {
        return StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("POST", "/todos", Map.of(), null),
                new StepResult.Response(201, Map.of("Location", "/todos/1"), body));
    }

    @Test
    void resolvesJsonFieldFromPriorStep() throws TemplateResolver.ResolutionException {
        List<StepResult> steps = List.of(stepWithJsonBody("{\"id\":\"abc123\"}"));

        String resolved = resolver.resolveString("/todos/{{steps[0].response.json.id}}", steps);

        assertEquals("/todos/abc123", resolved);
    }

    @Test
    void resolvesHeaderFromPriorStep() throws TemplateResolver.ResolutionException {
        List<StepResult> steps = List.of(stepWithJsonBody("{}"));

        String resolved = resolver.resolveString("{{steps[0].response.headers.Location}}", steps);

        assertEquals("/todos/1", resolved);
    }

    @Test
    void resolvesStatusFromPriorStep() throws TemplateResolver.ResolutionException {
        List<StepResult> steps = List.of(stepWithJsonBody("{}"));

        String resolved = resolver.resolveString("{{steps[0].response.status}}", steps);

        assertEquals("201", resolved);
    }

    @Test
    void passesThroughStringsWithNoTemplate() throws TemplateResolver.ResolutionException {
        assertEquals("/todos", resolver.resolveString("/todos", List.of()));
    }

    @Test
    void throwsResolutionExceptionOnOutOfRangeIndex() {
        assertThrows(TemplateResolver.ResolutionException.class,
                () -> resolver.resolveString("{{steps[0].response.status}}", List.of()));
    }

    @Test
    void throwsResolutionExceptionOnMissingJsonField() {
        List<StepResult> steps = List.of(stepWithJsonBody("{\"id\":\"abc123\"}"));

        assertThrows(TemplateResolver.ResolutionException.class,
                () -> resolver.resolveString("{{steps[0].response.json.missing}}", steps));
    }

    @Test
    void throwsResolutionExceptionWhenStepHasNoResponse() {
        List<StepResult> steps = List.of(StepResult.error("check", 10, "connection refused"));

        assertThrows(TemplateResolver.ResolutionException.class,
                () -> resolver.resolveString("{{steps[0].response.status}}", steps));
    }

    @Test
    @SuppressWarnings("unchecked")
    void resolvesNestedMapBody() throws TemplateResolver.ResolutionException {
        List<StepResult> steps = List.of(stepWithJsonBody("{\"id\":\"abc123\"}"));

        Object resolved = resolver.resolveBody(
                Map.of("todoId", "{{steps[0].response.json.id}}", "note", "static"), steps);

        Map<String, Object> resolvedMap = (Map<String, Object>) resolved;
        assertEquals("abc123", resolvedMap.get("todoId"));
        assertEquals("static", resolvedMap.get("note"));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd validation-engine && mvn -q test -Dtest=TemplateResolverTest
```

Expected: FAIL — `TemplateResolver` does not exist.

- [ ] **Step 3: Write the implementation**

```java
package com.practiceplatform.validationengine.engine;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class TemplateResolver {

    private static final Pattern TOKEN = Pattern.compile("\\{\\{\\s*(.+?)\\s*}}");
    private static final Pattern EXPR = Pattern.compile("steps\\[(\\d+)]\\.response\\.(.+)");

    public static class ResolutionException extends Exception {
        public ResolutionException(String reason) { super(reason); }
    }

    public String resolveString(String template, List<StepResult> priorSteps) throws ResolutionException {
        if (template == null) return null;
        Matcher matcher = TOKEN.matcher(template);
        StringBuilder result = new StringBuilder();
        int last = 0;
        while (matcher.find()) {
            result.append(template, last, matcher.start());
            result.append(resolveExpression(matcher.group(1), priorSteps));
            last = matcher.end();
        }
        result.append(template.substring(last));
        return result.toString();
    }

    public Map<String, String> resolveHeaders(Map<String, String> headers, List<StepResult> priorSteps)
            throws ResolutionException {
        if (headers == null) return Map.of();
        Map<String, String> resolved = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            resolved.put(entry.getKey(), resolveString(entry.getValue(), priorSteps));
        }
        return resolved;
    }

    @SuppressWarnings("unchecked")
    public Object resolveBody(Object body, List<StepResult> priorSteps) throws ResolutionException {
        if (body instanceof String s) {
            return resolveString(s, priorSteps);
        }
        if (body instanceof Map<?, ?> map) {
            Map<String, Object> resolved = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                resolved.put((String) entry.getKey(), resolveBody(entry.getValue(), priorSteps));
            }
            return resolved;
        }
        if (body instanceof List<?> list) {
            List<Object> resolved = new java.util.ArrayList<>();
            for (Object item : list) {
                resolved.add(resolveBody(item, priorSteps));
            }
            return resolved;
        }
        return body;
    }

    private String resolveExpression(String expression, List<StepResult> priorSteps) throws ResolutionException {
        Matcher matcher = EXPR.matcher(expression);
        if (!matcher.matches()) {
            throw new ResolutionException("unrecognized template expression: " + expression);
        }
        int index = Integer.parseInt(matcher.group(1));
        String path = matcher.group(2);

        if (index < 0 || index >= priorSteps.size()) {
            throw new ResolutionException("step index out of range: " + index);
        }
        StepResult step = priorSteps.get(index);
        StepResult.Response response = step.response();
        if (response == null) {
            throw new ResolutionException("step " + index + " has no response (status=" + step.status() + ")");
        }

        if (path.equals("status")) {
            return String.valueOf(response.status());
        }
        if (path.startsWith("headers.")) {
            String headerName = path.substring("headers.".length());
            String value = response.header(headerName);
            if (value == null) {
                throw new ResolutionException("step " + index + " response has no header: " + headerName);
            }
            return value;
        }
        if (path.startsWith("json.")) {
            String jsonPath = path.substring("json.".length());
            JsonNode node;
            try {
                node = response.json();
            } catch (Exception e) {
                throw new ResolutionException("step " + index + " response body is not valid JSON");
            }
            if (node == null) {
                throw new ResolutionException("step " + index + " response body is empty");
            }
            for (String segment : jsonPath.split("\\.")) {
                node = node.get(segment);
                if (node == null) {
                    throw new ResolutionException("step " + index + " response JSON has no field: " + jsonPath);
                }
            }
            return node.isTextual() ? node.asText() : node.toString();
        }
        throw new ResolutionException("unrecognized response path: " + path);
    }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd validation-engine && mvn -q test -Dtest=TemplateResolverTest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add validation-engine/src/main/java/com/practiceplatform/validationengine/engine/TemplateResolver.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/engine/TemplateResolverTest.java
git commit -m "feat: resolve {{steps[i].response...}} templates"
```

---

## Task 7: AssertionFactory + StepExecutor

**Files:**
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/AssertionFactory.java`
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/engine/StepExecutor.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/engine/StepExecutorTest.java`

**Interfaces:**
- Consumes: `SsrfGuardedHttpClient.send(...)` (Task 4), `TemplateResolver` (Task 6), `StepResult` (Task 5), `ChallengeSpec`/`CheckSpec` (Task 2). `AssertionFactory.build(CheckSpec.ExpectSpec, String openapiSpecPath): List<Assertion>` (uses `StatusAssertion`/`HeaderAssertion`/`JsonAssertion` from Task 5; wired for `JwtClaimsAssertion`/`JsonSchemaAssertion`/`OpenApiAssertion` added in Tasks 8-10).
- Produces: `StepExecutor(SsrfGuardedHttpClient, TemplateResolver, AssertionFactory, String targetBaseUrl)` and `StepExecutor.run(ChallengeSpec): List<StepResult>` — used by `RunController` (Task 13).

- [ ] **Step 1: Write the failing test**

```java
package com.practiceplatform.validationengine.engine;

import com.practiceplatform.validationengine.assertions.AssertionFactory;
import com.practiceplatform.validationengine.http.AllowAllSsrfGuard;
import com.practiceplatform.validationengine.http.SsrfGuardedHttpClient;
import com.practiceplatform.validationengine.yaml.ChallengeYamlParser;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StepExecutorTest {

    private HttpServer server;
    private int port;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        port = server.getAddress().getPort();

        server.createContext("/todos", exchange -> {
            byte[] body = "{\"id\":\"1\",\"title\":\"Buy milk\",\"completed\":false}".getBytes();
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.getResponseHeaders().add("Location", "/todos/1");
            exchange.sendResponseHeaders(201, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.createContext("/todos/1", exchange -> {
            String method = exchange.getRequestMethod();
            if (method.equals("DELETE")) {
                exchange.sendResponseHeaders(204, -1);
            } else {
                byte[] body = "{\"id\":\"1\",\"title\":\"Buy milk\"}".getBytes();
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
            }
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    private StepExecutor executor() {
        SsrfGuardedHttpClient httpClient = new SsrfGuardedHttpClient(new AllowAllSsrfGuard());
        return new StepExecutor(httpClient, new TemplateResolver(), new AssertionFactory(),
                "http://localhost:" + port);
    }

    @Test
    void runsCrudChallengeChainingStepZeroIdIntoLaterPaths() throws IOException {
        String yaml = Files.readString(Path.of("src/test/resources/challenges/todo-api-crud.yaml"));
        ChallengeSpec spec = new ChallengeYamlParser().parse(yaml);

        List<StepResult> steps = executor().run(spec);

        assertEquals(3, steps.size());
        assertEquals(StepResult.Status.PASSED, steps.get(0).status());
        assertEquals(StepResult.Status.PASSED, steps.get(1).status());
        assertEquals(StepResult.Status.PASSED, steps.get(2).status());
        assertEquals("/todos/1", steps.get(1).request().path());
    }

    @Test
    void skipsCheckWhenTemplateResolutionFails() throws IOException {
        String yaml = """
                id: broken-chain
                title: "Broken chain"
                category: crud
                checks:
                  - name: "GET /todos/{missing step reference}"
                    request:
                      method: GET
                      path: "/todos/{{steps[5].response.json.id}}"
                    expect:
                      status: 200
                    points: 10
                """;
        ChallengeSpec spec = new ChallengeYamlParser().parse(yaml);

        List<StepResult> steps = executor().run(spec);

        assertEquals(1, steps.size());
        assertEquals(StepResult.Status.SKIPPED, steps.get(0).status());
    }

    @Test
    void laterStepCanReadEarlierStepsResponseEvenIfEarlierAssertionsFailed() throws IOException {
        String yaml = """
                id: chain-with-failed-assertion
                title: "Chain with failed assertion"
                category: crud
                checks:
                  - name: "POST /todos (assert wrong status on purpose)"
                    request:
                      method: POST
                      path: /todos
                      body:
                        title: "Buy milk"
                    expect:
                      status: 999
                    points: 10
                  - name: "GET /todos/{id} still resolves from step 0"
                    request:
                      method: GET
                      path: "/todos/{{steps[0].response.json.id}}"
                    expect:
                      status: 200
                    points: 10
                """;
        ChallengeSpec spec = new ChallengeYamlParser().parse(yaml);

        List<StepResult> steps = executor().run(spec);

        assertEquals(StepResult.Status.FAILED, steps.get(0).status());
        assertEquals(StepResult.Status.PASSED, steps.get(1).status());
        assertEquals("/todos/1", steps.get(1).request().path());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd validation-engine && mvn -q test -Dtest=StepExecutorTest
```

Expected: FAIL — `AssertionFactory`, `StepExecutor` do not exist.

- [ ] **Step 3: Write the implementation**

`validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/AssertionFactory.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.CheckSpec;

import java.util.ArrayList;
import java.util.List;

public class AssertionFactory {

    public List<Assertion> build(CheckSpec.ExpectSpec expect, String openapiSpecPath) {
        List<Assertion> assertions = new ArrayList<>();
        if (expect.getStatus() != null) {
            assertions.add(new StatusAssertion(expect.getStatus()));
        }
        if (expect.getHeaders() != null) {
            assertions.add(new HeaderAssertion(expect.getHeaders()));
        }
        if (expect.getJson() != null) {
            assertions.add(new JsonAssertion(expect.getJson()));
        }
        if (expect.getJwtClaims() != null) {
            assertions.add(new JwtClaimsAssertion(expect.getJwtClaims()));
        }
        if (expect.getJsonSchema() != null) {
            assertions.add(new JsonSchemaAssertion(expect.getJsonSchema()));
        }
        if (Boolean.TRUE.equals(expect.getMatchesOpenApi())) {
            assertions.add(new OpenApiAssertion(openapiSpecPath));
        }
        return assertions;
    }
}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/engine/StepExecutor.java`:

```java
package com.practiceplatform.validationengine.engine;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.practiceplatform.validationengine.assertions.Assertion;
import com.practiceplatform.validationengine.assertions.AssertionFactory;
import com.practiceplatform.validationengine.http.SsrfGuardedHttpClient;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class StepExecutor {

    private final SsrfGuardedHttpClient httpClient;
    private final TemplateResolver templateResolver;
    private final AssertionFactory assertionFactory;
    private final String targetBaseUrl;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public StepExecutor(SsrfGuardedHttpClient httpClient, TemplateResolver templateResolver,
                         AssertionFactory assertionFactory, String targetBaseUrl) {
        this.httpClient = httpClient;
        this.templateResolver = templateResolver;
        this.assertionFactory = assertionFactory;
        this.targetBaseUrl = targetBaseUrl;
    }

    public List<StepResult> run(ChallengeSpec spec) {
        List<StepResult> steps = new ArrayList<>();
        for (CheckSpec check : spec.getChecks()) {
            steps.add(executeOne(check, spec.getOpenapiSpec(), steps));
        }
        return steps;
    }

    private StepResult executeOne(CheckSpec check, String openapiSpecPath, List<StepResult> priorSteps) {
        String path;
        Map<String, String> headers;
        Object body;
        try {
            path = templateResolver.resolveString(check.getRequest().getPath(), priorSteps);
            headers = templateResolver.resolveHeaders(check.getRequest().getHeaders(), priorSteps);
            body = templateResolver.resolveBody(check.getRequest().getBody(), priorSteps);
        } catch (TemplateResolver.ResolutionException e) {
            return StepResult.skipped(check.getName(), check.getPoints(), e.getMessage());
        }

        String method = check.getRequest().getMethod();
        String url = targetBaseUrl + path;
        String bodyJson;
        try {
            bodyJson = body == null ? null : objectMapper.writeValueAsString(body);
        } catch (JsonProcessingException e) {
            return StepResult.error(check.getName(), check.getPoints(),
                    "failed to serialize request body: " + e.getMessage());
        }

        SsrfGuardedHttpClient.RawResponse raw;
        try {
            raw = httpClient.send(method, url, headers, bodyJson);
        } catch (Exception e) {
            return StepResult.error(check.getName(), check.getPoints(), e.getMessage());
        }

        StepResult.ResolvedRequest resolvedRequest = new StepResult.ResolvedRequest(method, path, headers, body);
        StepResult.Response response = new StepResult.Response(raw.status(), raw.headers(), raw.body());
        StepResult result = StepResult.forExecuted(check.getName(), check.getPoints(), resolvedRequest, response);

        for (Assertion assertion : assertionFactory.build(check.getExpect(), openapiSpecPath)) {
            result.addAssertionResult(assertion.evaluate(result));
        }
        result.finalizeStatus();
        return result;
    }
}
```

Note: this task's test only exercises `status`/`json`/`headers` assertions (already implemented in Task 5); `AssertionFactory` also references `JwtClaimsAssertion`, `JsonSchemaAssertion`, `OpenApiAssertion`, which do not exist until Tasks 8-10 — write those three classes as empty stubs implementing `Assertion` now so this task compiles, then replace the stub bodies in Tasks 8-10:

`validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/JwtClaimsAssertion.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;

import java.util.Map;

public class JwtClaimsAssertion implements Assertion {
    public JwtClaimsAssertion(Map<String, Object> expectedClaims) {}

    @Override
    public AssertionResult evaluate(StepResult step) {
        throw new UnsupportedOperationException("implemented in Task 8");
    }
}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/JsonSchemaAssertion.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;

public class JsonSchemaAssertion implements Assertion {
    public JsonSchemaAssertion(String schemaClasspathPath) {}

    @Override
    public AssertionResult evaluate(StepResult step) {
        throw new UnsupportedOperationException("implemented in Task 9");
    }
}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/OpenApiAssertion.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;

public class OpenApiAssertion implements Assertion {
    public OpenApiAssertion(String openapiSpecPath) {}

    @Override
    public AssertionResult evaluate(StepResult step) {
        throw new UnsupportedOperationException("implemented in Task 10");
    }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd validation-engine && mvn -q test -Dtest=StepExecutorTest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/AssertionFactory.java \
        validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/JwtClaimsAssertion.java \
        validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/JsonSchemaAssertion.java \
        validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/OpenApiAssertion.java \
        validation-engine/src/main/java/com/practiceplatform/validationengine/engine/StepExecutor.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/engine/StepExecutorTest.java
git commit -m "feat: execute checks in order with template resolution and chaining"
```

---

## Task 8: JwtClaimsAssertion

**Files:**
- Create: `validation-engine/src/test/resources/challenges/jwt-auth-basics.yaml`
- Modify: `validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/JwtClaimsAssertion.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/JwtClaimsAssertionTest.java`

**Interfaces:**
- Consumes: `StepResult` (Task 5).
- Produces: real `JwtClaimsAssertion(Map<String,Object> expectedClaims)` behavior — used by `AssertionFactory` (Task 7, already wired) and Task 14's auth end-to-end test.

- [ ] **Step 1: Write the auth fixture YAML and the failing test**

`validation-engine/src/test/resources/challenges/jwt-auth-basics.yaml`:

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

`validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/JwtClaimsAssertionTest.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JwtClaimsAssertionTest {

    private String mintToken(String payloadJson) {
        String header = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8));
        String payload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(payloadJson.getBytes(StandardCharsets.UTF_8));
        return header + "." + payload + ".fakesig";
    }

    private StepResult stepWithAuthHeader(String authHeaderValue) {
        return StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/profile", Map.of("Authorization", authHeaderValue), null),
                new StepResult.Response(200, Map.of(), "{}"));
    }

    @Test
    void passesWhenClaimExists() {
        String token = mintToken("{\"sub\":\"test-user\"}");
        StepResult step = stepWithAuthHeader("Bearer " + token);

        assertTrue(new JwtClaimsAssertion(Map.of("sub", "exists")).evaluate(step).passed());
    }

    @Test
    void passesWhenClaimValueMatches() {
        String token = mintToken("{\"sub\":\"test-user\"}");
        StepResult step = stepWithAuthHeader("Bearer " + token);

        assertTrue(new JwtClaimsAssertion(Map.of("sub", "test-user")).evaluate(step).passed());
    }

    @Test
    void failsWhenClaimMissing() {
        String token = mintToken("{\"iat\":123}");
        StepResult step = stepWithAuthHeader("Bearer " + token);

        assertFalse(new JwtClaimsAssertion(Map.of("sub", "exists")).evaluate(step).passed());
    }

    @Test
    void failsWhenNoAuthorizationHeader() {
        StepResult step = StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/profile", Map.of(), null),
                new StepResult.Response(200, Map.of(), "{}"));

        assertFalse(new JwtClaimsAssertion(Map.of("sub", "exists")).evaluate(step).passed());
    }

    @Test
    void failsWhenTokenIsMalformed() {
        StepResult step = stepWithAuthHeader("Bearer not-a-real-token");

        assertFalse(new JwtClaimsAssertion(Map.of("sub", "exists")).evaluate(step).passed());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd validation-engine && mvn -q test -Dtest=JwtClaimsAssertionTest
```

Expected: FAIL — stub throws `UnsupportedOperationException`.

- [ ] **Step 3: Write the implementation**

```java
package com.practiceplatform.validationengine.assertions;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.practiceplatform.validationengine.engine.StepResult;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;

public class JwtClaimsAssertion implements Assertion {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final Map<String, Object> expectedClaims;

    public JwtClaimsAssertion(Map<String, Object> expectedClaims) {
        this.expectedClaims = expectedClaims;
    }

    @Override
    public AssertionResult evaluate(StepResult step) {
        String authHeader = step.request().headers().entrySet().stream()
                .filter(e -> e.getKey().equalsIgnoreCase("Authorization"))
                .map(Map.Entry::getValue)
                .findFirst().orElse(null);

        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            return new AssertionResult("jwtClaims", false, "no Bearer token on this check's Authorization header");
        }
        String token = authHeader.substring("Bearer ".length());
        String[] parts = token.split("\\.");
        if (parts.length < 2) {
            return new AssertionResult("jwtClaims", false, "malformed JWT: expected header.payload.signature");
        }

        JsonNode claims;
        try {
            byte[] payloadBytes = Base64.getUrlDecoder().decode(parts[1]);
            claims = JSON.readTree(new String(payloadBytes, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new AssertionResult("jwtClaims", false, "failed to decode JWT payload: " + e.getMessage());
        }

        for (Map.Entry<String, Object> entry : expectedClaims.entrySet()) {
            JsonNode actual = claims.get(entry.getKey());
            if (actual == null) {
                return new AssertionResult("jwtClaims", false, "claim missing: " + entry.getKey());
            }
            if ("exists".equals(entry.getValue())) continue;
            String actualText = actual.isTextual() ? actual.asText() : actual.toString();
            if (!String.valueOf(entry.getValue()).equals(actualText)) {
                return new AssertionResult("jwtClaims", false,
                        "claim " + entry.getKey() + " expected " + entry.getValue() + " but got " + actual);
            }
        }
        return new AssertionResult("jwtClaims", true, "all claims matched");
    }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd validation-engine && mvn -q test -Dtest=JwtClaimsAssertionTest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/JwtClaimsAssertion.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/JwtClaimsAssertionTest.java \
        validation-engine/src/test/resources/challenges/jwt-auth-basics.yaml
git commit -m "feat: decode and assert JWT claims from the current request's Authorization header"
```

---

## Task 9: JsonSchemaAssertion

**Files:**
- Create: `validation-engine/src/test/resources/challenges/todo-schema.json`
- Modify: `validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/JsonSchemaAssertion.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/JsonSchemaAssertionTest.java`

**Interfaces:**
- Produces: real `JsonSchemaAssertion(String schemaClasspathPath)` behavior, resolving the path against classpath `/challenges/<path>` — used by `AssertionFactory` (Task 7, already wired).

- [ ] **Step 1: Write the schema fixture and the failing test**

`validation-engine/src/test/resources/challenges/todo-schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["id", "title", "completed"],
  "properties": {
    "id": { "type": "string" },
    "title": { "type": "string" },
    "completed": { "type": "boolean" }
  }
}
```

`validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/JsonSchemaAssertionTest.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JsonSchemaAssertionTest {

    @Test
    void passesWhenBodyMatchesSchema() {
        StepResult.Response response = new StepResult.Response(200, Map.of("Content-Type", "application/json"),
                "{\"id\":\"1\",\"title\":\"Buy milk\",\"completed\":false}");
        StepResult step = StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/todos/1", Map.of(), null), response);

        assertTrue(new JsonSchemaAssertion("todo-schema.json").evaluate(step).passed());
    }

    @Test
    void failsWhenRequiredFieldMissing() {
        StepResult.Response response = new StepResult.Response(200, Map.of("Content-Type", "application/json"),
                "{\"id\":\"1\",\"title\":\"Buy milk\"}");
        StepResult step = StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/todos/1", Map.of(), null), response);

        assertFalse(new JsonSchemaAssertion("todo-schema.json").evaluate(step).passed());
    }

    @Test
    void failsWhenSchemaNotFoundOnClasspath() {
        StepResult.Response response = new StepResult.Response(200, Map.of(), "{}");
        StepResult step = StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/todos/1", Map.of(), null), response);

        assertFalse(new JsonSchemaAssertion("does-not-exist.json").evaluate(step).passed());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd validation-engine && mvn -q test -Dtest=JsonSchemaAssertionTest
```

Expected: FAIL — stub throws `UnsupportedOperationException`.

- [ ] **Step 3: Write the implementation**

```java
package com.practiceplatform.validationengine.assertions;

import com.fasterxml.jackson.databind.JsonNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import com.practiceplatform.validationengine.engine.StepResult;

import java.io.InputStream;
import java.util.Set;

public class JsonSchemaAssertion implements Assertion {
    private static final JsonSchemaFactory FACTORY = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);

    private final String schemaClasspathPath;

    public JsonSchemaAssertion(String schemaClasspathPath) {
        this.schemaClasspathPath = schemaClasspathPath;
    }

    @Override
    public AssertionResult evaluate(StepResult step) {
        JsonNode body;
        try {
            body = step.response().json();
        } catch (Exception e) {
            return new AssertionResult("jsonSchema", false, "response body is not valid JSON");
        }
        if (body == null) {
            return new AssertionResult("jsonSchema", false, "response body is empty");
        }

        String resourcePath = "/challenges/" + schemaClasspathPath;
        try (InputStream in = getClass().getResourceAsStream(resourcePath)) {
            if (in == null) {
                return new AssertionResult("jsonSchema", false, "schema not found on classpath: " + resourcePath);
            }
            JsonSchema schema = FACTORY.getSchema(in);
            Set<ValidationMessage> errors = schema.validate(body);
            if (errors.isEmpty()) {
                return new AssertionResult("jsonSchema", true, "response body matches schema");
            }
            return new AssertionResult("jsonSchema", false, "schema violations: " + errors);
        } catch (Exception e) {
            return new AssertionResult("jsonSchema", false, "schema validation error: " + e.getMessage());
        }
    }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd validation-engine && mvn -q test -Dtest=JsonSchemaAssertionTest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/JsonSchemaAssertion.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/JsonSchemaAssertionTest.java \
        validation-engine/src/test/resources/challenges/todo-schema.json
git commit -m "feat: validate response bodies against a bundled JSON Schema"
```

---

## Task 10: OpenApiAssertion

**Files:**
- Create: `validation-engine/src/test/resources/openapi/todo-api.yaml`
- Create: `validation-engine/src/test/resources/challenges/todo-api-contract.yaml`
- Modify: `validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/OpenApiAssertion.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/OpenApiAssertionTest.java`

**Interfaces:**
- Produces: real `OpenApiAssertion(String openapiSpecPath)` behavior, resolving the path against classpath root `/` — used by `AssertionFactory` (Task 7, already wired) and Task 14's contract end-to-end test.

- [ ] **Step 1: Write the OpenAPI fixture, contract challenge fixture, and the failing test**

`validation-engine/src/test/resources/openapi/todo-api.yaml`:

```yaml
openapi: 3.0.3
info:
  title: Todo API
  version: "1.0"
paths:
  /todos:
    post:
      operationId: createTodo
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [title]
              properties:
                title:
                  type: string
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                type: object
                required: [id, title, completed]
                properties:
                  id:
                    type: string
                  title:
                    type: string
                  completed:
                    type: boolean
```

`validation-engine/src/test/resources/challenges/todo-api-contract.yaml`:

```yaml
id: todo-api-contract
title: "Todo API conforms to its OpenAPI contract"
category: contract
openapiSpec: openapi/todo-api.yaml
checks:
  - name: "POST /todos response matches OpenAPI spec"
    request:
      method: POST
      path: /todos
      headers:
        Content-Type: application/json
      body:
        title: "Buy milk"
    expect:
      status: 201
      matchesOpenApi: true
    points: 10
```

`validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/OpenApiAssertionTest.java`:

```java
package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class OpenApiAssertionTest {

    @Test
    void passesWhenRequestAndResponseConformToSpec() {
        StepResult.ResolvedRequest request = new StepResult.ResolvedRequest(
                "POST", "/todos", Map.of("Content-Type", "application/json"), Map.of("title", "Buy milk"));
        StepResult.Response response = new StepResult.Response(201, Map.of("Content-Type", "application/json"),
                "{\"id\":\"1\",\"title\":\"Buy milk\",\"completed\":false}");
        StepResult step = StepResult.forExecuted("check", 10, request, response);

        assertTrue(new OpenApiAssertion("openapi/todo-api.yaml").evaluate(step).passed());
    }

    @Test
    void failsWhenResponseMissingRequiredField() {
        StepResult.ResolvedRequest request = new StepResult.ResolvedRequest(
                "POST", "/todos", Map.of("Content-Type", "application/json"), Map.of("title", "Buy milk"));
        StepResult.Response response = new StepResult.Response(201, Map.of("Content-Type", "application/json"),
                "{\"id\":\"1\",\"title\":\"Buy milk\"}");
        StepResult step = StepResult.forExecuted("check", 10, request, response);

        assertFalse(new OpenApiAssertion("openapi/todo-api.yaml").evaluate(step).passed());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd validation-engine && mvn -q test -Dtest=OpenApiAssertionTest
```

Expected: FAIL — stub throws `UnsupportedOperationException`.

- [ ] **Step 3: Write the implementation**

```java
package com.practiceplatform.validationengine.assertions;

import com.atlassian.oai.validator.OpenApiInteractionValidator;
import com.atlassian.oai.validator.model.SimpleRequest;
import com.atlassian.oai.validator.model.SimpleResponse;
import com.atlassian.oai.validator.report.ValidationReport;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.practiceplatform.validationengine.engine.StepResult;

import java.net.URL;

public class OpenApiAssertion implements Assertion {
    private static final ObjectMapper JSON = new ObjectMapper();

    private final String openapiSpecPath;

    public OpenApiAssertion(String openapiSpecPath) {
        this.openapiSpecPath = openapiSpecPath;
    }

    @Override
    public AssertionResult evaluate(StepResult step) {
        if (openapiSpecPath == null) {
            return new AssertionResult("matchesOpenApi", false, "challenge has no openapiSpec configured");
        }
        URL specUrl = getClass().getResource("/" + openapiSpecPath);
        if (specUrl == null) {
            return new AssertionResult("matchesOpenApi", false,
                    "OpenAPI spec not found on classpath: /" + openapiSpecPath);
        }

        OpenApiInteractionValidator validator = OpenApiInteractionValidator
                .createFor(specUrl.toString())
                .build();

        SimpleRequest.Builder requestBuilder =
                new SimpleRequest.Builder(step.request().method(), step.request().path());
        step.request().headers().forEach(requestBuilder::withHeader);
        if (step.request().body() != null) {
            try {
                requestBuilder.withBody(JSON.writeValueAsString(step.request().body()));
            } catch (Exception e) {
                return new AssertionResult("matchesOpenApi", false, "failed to serialize request body");
            }
        }

        SimpleResponse.Builder responseBuilder = new SimpleResponse.Builder(step.response().status());
        if (step.response().bodyRaw() != null) {
            responseBuilder.withBody(step.response().bodyRaw());
        }

        ValidationReport report = validator.validate(requestBuilder.build(), responseBuilder.build());
        if (!report.hasErrors()) {
            return new AssertionResult("matchesOpenApi", true, "request/response conform to OpenAPI spec");
        }
        return new AssertionResult("matchesOpenApi", false, "OpenAPI violations: " + report.getMessages());
    }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd validation-engine && mvn -q test -Dtest=OpenApiAssertionTest
```

Expected: PASS. If the build fails on `SimpleRequest.Builder`/`SimpleResponse.Builder` method names, check the installed `swagger-request-validator-core` version's javadoc for the exact builder API — the validation logic above is correct, only exact method names carry third-party version risk.

- [ ] **Step 5: Commit**

```bash
git add validation-engine/src/main/java/com/practiceplatform/validationengine/assertions/OpenApiAssertion.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/assertions/OpenApiAssertionTest.java \
        validation-engine/src/test/resources/openapi/todo-api.yaml \
        validation-engine/src/test/resources/challenges/todo-api-contract.yaml
git commit -m "feat: validate request/response pairs against a bundled OpenAPI spec"
```

---

## Task 11: ScoreCalculator + RunResult

**Files:**
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/engine/ScoreCalculator.java`
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/engine/RunResult.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/engine/ScoreCalculatorTest.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/engine/RunResultTest.java`

**Interfaces:**
- Consumes: `StepResult` (Task 5).
- Produces: `ScoreCalculator.calculate(List<StepResult>): ScoreCalculator.ScoredRun` where `ScoredRun(int score, List<CheckResult> checks)` and `CheckResult(String name, String status, int points, int pointsEarned, List<AssertionDto> assertions)`. `RunResult.completed(String jobId, ScoreCalculator.ScoredRun): RunResult`, `RunResult.error(String jobId, String message): RunResult` — used by `RunController` (Task 13) and `WebhookNotifier` (Task 12).

- [ ] **Step 1: Write the failing tests**

`validation-engine/src/test/java/com/practiceplatform/validationengine/engine/ScoreCalculatorTest.java`:

```java
package com.practiceplatform.validationengine.engine;

import com.practiceplatform.validationengine.assertions.AssertionResult;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ScoreCalculatorTest {

    private StepResult passedStep(String name, int points) {
        StepResult step = StepResult.forExecuted(name, points,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(200, Map.of(), "{}"));
        step.addAssertionResult(new AssertionResult("status", true, "ok"));
        step.finalizeStatus();
        return step;
    }

    private StepResult failedStep(String name, int points) {
        StepResult step = StepResult.forExecuted(name, points,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(500, Map.of(), "{}"));
        step.addAssertionResult(new AssertionResult("status", false, "expected 200 but got 500"));
        step.finalizeStatus();
        return step;
    }

    @Test
    void scoresOneHundredWhenAllChecksPass() {
        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(
                List.of(passedStep("a", 10), passedStep("b", 5)));

        assertEquals(100, scored.score());
    }

    @Test
    void computesPartialScoreFromMixedResults() {
        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(
                List.of(passedStep("a", 10), failedStep("b", 10), passedStep("c", 5)));

        assertEquals(60, scored.score());
    }

    @Test
    void mapsErrorStepsToFailedWithZeroPointsEarned() {
        StepResult errored = StepResult.error("a", 10, "connection refused");

        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(List.of(errored));

        assertEquals(0, scored.score());
        assertEquals("failed", scored.checks().get(0).status());
        assertEquals(0, scored.checks().get(0).pointsEarned());
    }

    @Test
    void mapsSkippedStepsWithZeroPointsEarned() {
        StepResult skipped = StepResult.skipped("a", 10, "step index out of range: 5");

        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(List.of(skipped));

        assertEquals("skipped", scored.checks().get(0).status());
        assertEquals(0, scored.checks().get(0).pointsEarned());
    }

    @Test
    void scoresZeroWhenChallengeHasNoPoints() {
        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(List.of(passedStep("a", 0)));

        assertEquals(0, scored.score());
    }
}
```

`validation-engine/src/test/java/com/practiceplatform/validationengine/engine/RunResultTest.java`:

```java
package com.practiceplatform.validationengine.engine;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RunResultTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void completedResultOmitsErrorField() throws Exception {
        ScoreCalculator.ScoredRun scored = new ScoreCalculator.ScoredRun(100, List.of());
        RunResult result = RunResult.completed("job-1", scored);

        String json = mapper.writeValueAsString(result);

        assertTrue(json.contains("\"status\":\"completed\""));
        assertTrue(json.contains("\"score\":100"));
        assertFalse(json.contains("\"error\""));
    }

    @Test
    void errorResultOmitsScoreAndChecksFields() throws Exception {
        RunResult result = RunResult.error("job-2", "YAML parse failure: bad indentation");

        String json = mapper.writeValueAsString(result);

        assertTrue(json.contains("\"status\":\"error\""));
        assertTrue(json.contains("YAML parse failure"));
        assertFalse(json.contains("\"score\""));
        assertFalse(json.contains("\"checks\""));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd validation-engine && mvn -q test -Dtest=ScoreCalculatorTest,RunResultTest
```

Expected: FAIL — `ScoreCalculator`, `RunResult` do not exist.

- [ ] **Step 3: Write the implementation**

`validation-engine/src/main/java/com/practiceplatform/validationengine/engine/ScoreCalculator.java`:

```java
package com.practiceplatform.validationengine.engine;

import java.util.List;

public class ScoreCalculator {

    public record AssertionDto(String type, boolean passed, String detail) {}

    public record CheckResult(String name, String status, int points, int pointsEarned,
                               List<AssertionDto> assertions) {}

    public record ScoredRun(int score, List<CheckResult> checks) {}

    public ScoredRun calculate(List<StepResult> steps) {
        int totalPoints = steps.stream().mapToInt(StepResult::points).sum();
        int earnedPoints = steps.stream()
                .filter(s -> s.status() == StepResult.Status.PASSED)
                .mapToInt(StepResult::points)
                .sum();
        int score = totalPoints == 0 ? 0 : Math.round(100f * earnedPoints / totalPoints);

        List<CheckResult> checks = steps.stream().map(this::toCheckResult).toList();
        return new ScoredRun(score, checks);
    }

    private CheckResult toCheckResult(StepResult step) {
        String status = switch (step.status()) {
            case PASSED -> "passed";
            case FAILED, ERROR -> "failed";
            case SKIPPED -> "skipped";
        };
        int pointsEarned = step.status() == StepResult.Status.PASSED ? step.points() : 0;
        List<AssertionDto> assertions = step.assertions().stream()
                .map(a -> new AssertionDto(a.type(), a.passed(), a.detail()))
                .toList();
        return new CheckResult(step.checkName(), status, step.points(), pointsEarned, assertions);
    }
}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/engine/RunResult.java`:

```java
package com.practiceplatform.validationengine.engine;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class RunResult {
    private String jobId;
    private String status;
    private Integer score;
    private List<ScoreCalculator.CheckResult> checks;
    private String error;

    private RunResult() {}

    public static RunResult completed(String jobId, ScoreCalculator.ScoredRun scored) {
        RunResult result = new RunResult();
        result.jobId = jobId;
        result.status = "completed";
        result.score = scored.score();
        result.checks = scored.checks();
        return result;
    }

    public static RunResult error(String jobId, String message) {
        RunResult result = new RunResult();
        result.jobId = jobId;
        result.status = "error";
        result.error = message;
        return result;
    }

    public String getJobId() { return jobId; }
    public String getStatus() { return status; }
    public Integer getScore() { return score; }
    public List<ScoreCalculator.CheckResult> getChecks() { return checks; }
    public String getError() { return error; }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd validation-engine && mvn -q test -Dtest=ScoreCalculatorTest,RunResultTest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add validation-engine/src/main/java/com/practiceplatform/validationengine/engine/ScoreCalculator.java \
        validation-engine/src/main/java/com/practiceplatform/validationengine/engine/RunResult.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/engine/ScoreCalculatorTest.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/engine/RunResultTest.java
git commit -m "feat: compute run score and assemble the webhook result payload"
```

---

## Task 12: WebhookNotifier

**Files:**
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/engine/WebhookNotifier.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/engine/WebhookNotifierTest.java`

**Interfaces:**
- Consumes: `RunResult` (Task 11).
- Produces: `WebhookNotifier.notify(String webhookUrl, RunResult): void` — used by `RunController` (Task 13).

- [ ] **Step 1: Write the failing test**

```java
package com.practiceplatform.validationengine.engine;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertTrue;

class WebhookNotifierTest {

    private HttpServer server;
    private int port;
    private final AtomicReference<String> capturedBody = new AtomicReference<>();

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        port = server.getAddress().getPort();
        server.createContext("/webhook", exchange -> {
            capturedBody.set(new String(exchange.getRequestBody().readAllBytes()));
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    @Test
    void postsRunResultJsonToWebhookUrl() throws Exception {
        ScoreCalculator.ScoredRun scored = new ScoreCalculator.ScoredRun(100, List.of());
        RunResult result = RunResult.completed("job-1", scored);

        new WebhookNotifier().notify("http://localhost:" + port + "/webhook", result);

        assertTrue(capturedBody.get().contains("\"jobId\":\"job-1\""));
        assertTrue(capturedBody.get().contains("\"status\":\"completed\""));
        assertTrue(capturedBody.get().contains("\"score\":100"));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd validation-engine && mvn -q test -Dtest=WebhookNotifierTest
```

Expected: FAIL — `WebhookNotifier` does not exist.

- [ ] **Step 3: Write the implementation**

```java
package com.practiceplatform.validationengine.engine;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

public class WebhookNotifier {
    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;

    public WebhookNotifier() {
        this.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        this.objectMapper = new ObjectMapper();
    }

    public void notify(String webhookUrl, RunResult result) throws IOException, InterruptedException {
        String json = objectMapper.writeValueAsString(result);
        HttpRequest request = HttpRequest.newBuilder(URI.create(webhookUrl))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(10))
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build();
        httpClient.send(request, HttpResponse.BodyHandlers.discarding());
    }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd validation-engine && mvn -q test -Dtest=WebhookNotifierTest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add validation-engine/src/main/java/com/practiceplatform/validationengine/engine/WebhookNotifier.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/engine/WebhookNotifierTest.java
git commit -m "feat: deliver run results to the caller-supplied webhook"
```

---

## Task 13: RunController (POST /runs)

**Files:**
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/web/RunRequest.java`
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/web/RunAccepted.java`
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/web/RunController.java`
- Create: `validation-engine/src/main/java/com/practiceplatform/validationengine/web/EngineConfig.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/web/RunControllerTest.java`

**Interfaces:**
- Consumes: `ChallengeYamlParser` (Task 2), `StepExecutor` (Task 7), `ScoreCalculator` (Task 11), `RunResult` (Task 11), `WebhookNotifier` (Task 12), `SsrfGuardedHttpClient` (Task 4).
- Produces: `POST /runs` accepting `RunRequest(String jobId, String targetUrl, String challengeYaml, String webhookUrl)`, returning `202` with `RunAccepted(String jobId, String status)` — this is the module's full public surface, ready for subsystem #3 to call.

- [ ] **Step 1: Write the failing test**

```java
package com.practiceplatform.validationengine.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.practiceplatform.validationengine.engine.WebhookNotifier;
import com.practiceplatform.validationengine.http.AllowAllSsrfGuard;
import com.practiceplatform.validationengine.http.SsrfGuardedHttpClient;
import com.practiceplatform.validationengine.yaml.ChallengeYamlParser;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class RunControllerTest {

    private HttpServer candidateServer;
    private HttpServer webhookServer;
    private int candidatePort;
    private int webhookPort;
    private MockMvc mockMvc;
    private final CountDownLatch webhookReceived = new CountDownLatch(1);
    private final AtomicReference<String> webhookBody = new AtomicReference<>();

    @BeforeEach
    void setUp() throws IOException {
        candidateServer = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        candidatePort = candidateServer.getAddress().getPort();
        candidateServer.createContext("/todos", exchange -> {
            byte[] body = "{\"id\":\"1\",\"title\":\"Buy milk\",\"completed\":false}".getBytes();
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.getResponseHeaders().add("Location", "/todos/1");
            exchange.sendResponseHeaders(201, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        candidateServer.createContext("/todos/1", exchange -> {
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        candidateServer.start();

        webhookServer = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        webhookPort = webhookServer.getAddress().getPort();
        webhookServer.createContext("/webhook", exchange -> {
            webhookBody.set(new String(exchange.getRequestBody().readAllBytes()));
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
            webhookReceived.countDown();
        });
        webhookServer.start();

        SsrfGuardedHttpClient httpClient = new SsrfGuardedHttpClient(new AllowAllSsrfGuard());
        RunController controller = new RunController(new ChallengeYamlParser(), httpClient, new WebhookNotifier());
        mockMvc = MockMvcBuilders.standaloneSetup(controller).build();
    }

    @AfterEach
    void tearDown() {
        candidateServer.stop(0);
        webhookServer.stop(0);
    }

    @Test
    void acceptsRunAndDeliversScoredWebhook() throws Exception {
        String yaml = """
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
                  - name: "DELETE /todos/{id} removes it"
                    request:
                      method: DELETE
                      path: "/todos/1"
                    expect:
                      status: 204
                    points: 5
                """;

        ObjectMapper objectMapper = new ObjectMapper();
        String requestBody = objectMapper.writeValueAsString(new RunRequest(
                "job-1",
                "http://localhost:" + candidatePort,
                yaml,
                "http://localhost:" + webhookPort + "/webhook"));

        mockMvc.perform(post("/runs")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(requestBody))
                .andExpect(status().isAccepted())
                .andExpect(content().json("{\"jobId\":\"job-1\",\"status\":\"accepted\"}"));

        assertTrue(webhookReceived.await(5, TimeUnit.SECONDS));
        String body = webhookBody.get();
        assertTrue(body.contains("\"status\":\"completed\""));
        assertTrue(body.contains("\"score\":100"));
    }

    @Test
    void reportsErrorStatusWhenYamlIsInvalid() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        String requestBody = objectMapper.writeValueAsString(new RunRequest(
                "job-2",
                "http://localhost:" + candidatePort,
                "id: [unterminated",
                "http://localhost:" + webhookPort + "/webhook"));

        mockMvc.perform(post("/runs")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(requestBody))
                .andExpect(status().isAccepted());

        assertTrue(webhookReceived.await(5, TimeUnit.SECONDS));
        assertTrue(webhookBody.get().contains("\"status\":\"error\""));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd validation-engine && mvn -q test -Dtest=RunControllerTest
```

Expected: FAIL — `RunController`, `RunRequest`, `RunAccepted` do not exist.

- [ ] **Step 3: Write the implementation**

`validation-engine/src/main/java/com/practiceplatform/validationengine/web/RunRequest.java`:

```java
package com.practiceplatform.validationengine.web;

public record RunRequest(String jobId, String targetUrl, String challengeYaml, String webhookUrl) {}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/web/RunAccepted.java`:

```java
package com.practiceplatform.validationengine.web;

public record RunAccepted(String jobId, String status) {}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/web/RunController.java`:

```java
package com.practiceplatform.validationengine.web;

import com.practiceplatform.validationengine.assertions.AssertionFactory;
import com.practiceplatform.validationengine.engine.ChallengeSpec;
import com.practiceplatform.validationengine.engine.RunResult;
import com.practiceplatform.validationengine.engine.ScoreCalculator;
import com.practiceplatform.validationengine.engine.StepExecutor;
import com.practiceplatform.validationengine.engine.StepResult;
import com.practiceplatform.validationengine.engine.TemplateResolver;
import com.practiceplatform.validationengine.engine.WebhookNotifier;
import com.practiceplatform.validationengine.http.SsrfGuardedHttpClient;
import com.practiceplatform.validationengine.yaml.ChallengeYamlParser;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@RestController
public class RunController {

    private final ChallengeYamlParser parser;
    private final SsrfGuardedHttpClient httpClient;
    private final WebhookNotifier webhookNotifier;
    private final ExecutorService executor;

    public RunController(ChallengeYamlParser parser, SsrfGuardedHttpClient httpClient, WebhookNotifier webhookNotifier) {
        this.parser = parser;
        this.httpClient = httpClient;
        this.webhookNotifier = webhookNotifier;
        this.executor = Executors.newVirtualThreadPerTaskExecutor();
    }

    @PostMapping("/runs")
    public ResponseEntity<RunAccepted> run(@RequestBody RunRequest request) {
        executor.submit(() -> processRun(request));
        return ResponseEntity.accepted().body(new RunAccepted(request.jobId(), "accepted"));
    }

    private void processRun(RunRequest request) {
        RunResult result;
        try {
            ChallengeSpec spec = parser.parse(request.challengeYaml());
            StepExecutor stepExecutor = new StepExecutor(
                    httpClient, new TemplateResolver(), new AssertionFactory(), request.targetUrl());
            List<StepResult> steps = stepExecutor.run(spec);
            ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(steps);
            result = RunResult.completed(request.jobId(), scored);
        } catch (Exception e) {
            result = RunResult.error(request.jobId(), e.getMessage());
        }

        try {
            webhookNotifier.notify(request.webhookUrl(), result);
        } catch (Exception ignored) {
        }
    }
}
```

`validation-engine/src/main/java/com/practiceplatform/validationengine/web/EngineConfig.java`:

```java
package com.practiceplatform.validationengine.web;

import com.practiceplatform.validationengine.engine.WebhookNotifier;
import com.practiceplatform.validationengine.http.SsrfGuard;
import com.practiceplatform.validationengine.http.SsrfGuardedHttpClient;
import com.practiceplatform.validationengine.yaml.ChallengeYamlParser;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class EngineConfig {

    @Bean
    public ChallengeYamlParser challengeYamlParser() {
        return new ChallengeYamlParser();
    }

    @Bean
    public SsrfGuardedHttpClient ssrfGuardedHttpClient() {
        return new SsrfGuardedHttpClient(new SsrfGuard());
    }

    @Bean
    public WebhookNotifier webhookNotifier() {
        return new WebhookNotifier();
    }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd validation-engine && mvn -q test -Dtest=RunControllerTest
```

Expected: PASS.

- [ ] **Step 5: Run the full test suite**

```bash
cd validation-engine && mvn -q test
```

Expected: `BUILD SUCCESS`, all tests from Tasks 1-13 pass.

- [ ] **Step 6: Commit**

```bash
git add validation-engine/src/main/java/com/practiceplatform/validationengine/web \
        validation-engine/src/test/java/com/practiceplatform/validationengine/web
git commit -m "feat: expose POST /runs, running challenges in the background and reporting via webhook"
```

---

## Task 14: Contract, status/headers, and auth end-to-end fixtures

**Files:**
- Create: `validation-engine/src/test/resources/challenges/status-headers-basics.yaml`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/engine/ContractChallengeEndToEndTest.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/engine/StatusHeadersChallengeEndToEndTest.java`
- Test: `validation-engine/src/test/java/com/practiceplatform/validationengine/engine/AuthChallengeEndToEndTest.java`

**Interfaces:**
- Consumes: `ChallengeYamlParser` (Task 2), `StepExecutor` (Task 7), `ScoreCalculator` (Task 11), `AllowAllSsrfGuard` (Task 4). No new production code — this task proves the four v1 categories (CRUD already covered by Tasks 2/7/13; contract, status/headers, auth added here) run end-to-end through the real engine pipeline, satisfying the design doc's "at least one fixture per category" testing requirement.

- [ ] **Step 1: Write the status/headers fixture and the three failing tests**

`validation-engine/src/test/resources/challenges/status-headers-basics.yaml`:

```yaml
id: status-headers-basics
title: "Status codes and headers"
category: status
checks:
  - name: "GET /health returns 200 with expected headers"
    request:
      method: GET
      path: /health
    expect:
      status: 200
      headers:
        X-Service: "todo-api"
        Content-Type: "regex:application/json.*"
    points: 10
  - name: "GET /missing returns 404"
    request:
      method: GET
      path: /missing
    expect:
      status: 404
    points: 5
```

`validation-engine/src/test/java/com/practiceplatform/validationengine/engine/ContractChallengeEndToEndTest.java`:

```java
package com.practiceplatform.validationengine.engine;

import com.practiceplatform.validationengine.assertions.AssertionFactory;
import com.practiceplatform.validationengine.http.AllowAllSsrfGuard;
import com.practiceplatform.validationengine.http.SsrfGuardedHttpClient;
import com.practiceplatform.validationengine.yaml.ChallengeYamlParser;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ContractChallengeEndToEndTest {

    private HttpServer server;
    private int port;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        port = server.getAddress().getPort();
        server.createContext("/todos", exchange -> {
            byte[] body = "{\"id\":\"1\",\"title\":\"Buy milk\",\"completed\":false}".getBytes();
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(201, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    @Test
    void scoresOneHundredWhenResponseConformsToOpenApiSpec() throws IOException {
        String yaml = Files.readString(Path.of("src/test/resources/challenges/todo-api-contract.yaml"));
        ChallengeSpec spec = new ChallengeYamlParser().parse(yaml);

        SsrfGuardedHttpClient httpClient = new SsrfGuardedHttpClient(new AllowAllSsrfGuard());
        StepExecutor executor = new StepExecutor(httpClient, new TemplateResolver(), new AssertionFactory(),
                "http://localhost:" + port);

        List<StepResult> steps = executor.run(spec);
        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(steps);

        assertEquals(100, scored.score());
    }
}
```

`validation-engine/src/test/java/com/practiceplatform/validationengine/engine/StatusHeadersChallengeEndToEndTest.java`:

```java
package com.practiceplatform.validationengine.engine;

import com.practiceplatform.validationengine.assertions.AssertionFactory;
import com.practiceplatform.validationengine.http.AllowAllSsrfGuard;
import com.practiceplatform.validationengine.http.SsrfGuardedHttpClient;
import com.practiceplatform.validationengine.yaml.ChallengeYamlParser;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class StatusHeadersChallengeEndToEndTest {

    private HttpServer server;
    private int port;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        port = server.getAddress().getPort();
        server.createContext("/health", exchange -> {
            byte[] body = "{}".getBytes();
            exchange.getResponseHeaders().add("X-Service", "todo-api");
            exchange.getResponseHeaders().add("Content-Type", "application/json; charset=UTF-8");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    @Test
    void scoresOneHundredForKnownEndpointAndMissingEndpoint() throws IOException {
        String yaml = Files.readString(Path.of("src/test/resources/challenges/status-headers-basics.yaml"));
        ChallengeSpec spec = new ChallengeYamlParser().parse(yaml);

        SsrfGuardedHttpClient httpClient = new SsrfGuardedHttpClient(new AllowAllSsrfGuard());
        StepExecutor executor = new StepExecutor(httpClient, new TemplateResolver(), new AssertionFactory(),
                "http://localhost:" + port);

        List<StepResult> steps = executor.run(spec);
        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(steps);

        assertEquals(100, scored.score());
    }
}
```

`validation-engine/src/test/java/com/practiceplatform/validationengine/engine/AuthChallengeEndToEndTest.java`:

```java
package com.practiceplatform.validationengine.engine;

import com.practiceplatform.validationengine.assertions.AssertionFactory;
import com.practiceplatform.validationengine.http.AllowAllSsrfGuard;
import com.practiceplatform.validationengine.http.SsrfGuardedHttpClient;
import com.practiceplatform.validationengine.yaml.ChallengeYamlParser;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class AuthChallengeEndToEndTest {

    private HttpServer server;
    private int port;
    private String validToken;

    @BeforeEach
    void startServer() throws IOException {
        String header = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8));
        String payload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"sub\":\"test-user\"}".getBytes(StandardCharsets.UTF_8));
        validToken = header + "." + payload + ".fakesig";

        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        port = server.getAddress().getPort();

        server.createContext("/login", exchange -> {
            byte[] body = ("{\"token\":\"" + validToken + "\"}").getBytes();
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.createContext("/profile", exchange -> {
            String auth = exchange.getRequestHeaders().getFirst("Authorization");
            int status = ("Bearer " + validToken).equals(auth) ? 200 : 401;
            exchange.sendResponseHeaders(status, -1);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    @Test
    void scoresOneHundredAcrossLoginAndProfileChecks() throws IOException {
        String yaml = Files.readString(Path.of("src/test/resources/challenges/jwt-auth-basics.yaml"));
        ChallengeSpec spec = new ChallengeYamlParser().parse(yaml);

        SsrfGuardedHttpClient httpClient = new SsrfGuardedHttpClient(new AllowAllSsrfGuard());
        StepExecutor executor = new StepExecutor(httpClient, new TemplateResolver(), new AssertionFactory(),
                "http://localhost:" + port);

        List<StepResult> steps = executor.run(spec);
        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(steps);

        assertEquals(100, scored.score());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd validation-engine && mvn -q test -Dtest=ContractChallengeEndToEndTest,StatusHeadersChallengeEndToEndTest,AuthChallengeEndToEndTest
```

Expected: FAIL — `status-headers-basics.yaml` fixture does not exist yet (the contract and auth fixtures already exist from Tasks 8/10, so those two tests may already pass; the status/headers test fails until its fixture is added).

- [ ] **Step 3: Add the missing fixture (already written in Step 1 above — no additional code needed)**

The `status-headers-basics.yaml` fixture from Step 1 is the only missing piece; `ContractChallengeEndToEndTest` and `AuthChallengeEndToEndTest` exercise fixtures already created in Tasks 8 and 10.

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd validation-engine && mvn -q test -Dtest=ContractChallengeEndToEndTest,StatusHeadersChallengeEndToEndTest,AuthChallengeEndToEndTest
```

Expected: PASS.

- [ ] **Step 5: Run the full test suite one last time**

```bash
cd validation-engine && mvn -q test
```

Expected: `BUILD SUCCESS` — all four v1 categories (CRUD, contract, status/headers, auth) proven end-to-end through the real engine pipeline.

- [ ] **Step 6: Commit**

```bash
git add validation-engine/src/test/resources/challenges/status-headers-basics.yaml \
        validation-engine/src/test/java/com/practiceplatform/validationengine/engine/ContractChallengeEndToEndTest.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/engine/StatusHeadersChallengeEndToEndTest.java \
        validation-engine/src/test/java/com/practiceplatform/validationengine/engine/AuthChallengeEndToEndTest.java
git commit -m "test: prove all four v1 assertion categories end-to-end through the real pipeline"
```
