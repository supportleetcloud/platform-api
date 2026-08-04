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
