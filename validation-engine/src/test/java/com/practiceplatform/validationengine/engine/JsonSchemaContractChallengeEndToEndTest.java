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

class JsonSchemaContractChallengeEndToEndTest {

    private HttpServer server;
    private int port;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        port = server.getAddress().getPort();
        server.createContext("/todos", exchange -> {
            byte[] body = "{\"id\":\"1\",\"title\":\"Buy milk\",\"completed\":false}".getBytes();
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            int status = "POST".equals(exchange.getRequestMethod()) ? 201 : 200;
            exchange.sendResponseHeaders(status, body.length);
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
    void scoresOneHundredWhenResponseMatchesJsonSchema() throws IOException {
        String yaml = Files.readString(Path.of("src/test/resources/challenges/todo-api-json-schema.yaml"));
        ChallengeSpec spec = new ChallengeYamlParser().parse(yaml);

        SsrfGuardedHttpClient httpClient = new SsrfGuardedHttpClient(new AllowAllSsrfGuard());
        StepExecutor executor = new StepExecutor(httpClient, new TemplateResolver(), new AssertionFactory(),
                "http://localhost:" + port);

        List<StepResult> steps = executor.run(spec);
        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(steps);

        assertEquals(100, scored.score());
    }

    @Test
    void scoresTwentyFiveWhenResponseViolatesJsonSchema() throws IOException {
        server.stop(0);
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        port = server.getAddress().getPort();
        server.createContext("/todos", exchange -> {
            // Missing the required "completed" field — violates todo-schema.json.
            byte[] body = "{\"id\":\"1\",\"title\":\"Buy milk\"}".getBytes();
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            int status = "POST".equals(exchange.getRequestMethod()) ? 201 : 200;
            exchange.sendResponseHeaders(status, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();

        String yaml = Files.readString(Path.of("src/test/resources/challenges/todo-api-json-schema.yaml"));
        ChallengeSpec spec = new ChallengeYamlParser().parse(yaml);

        SsrfGuardedHttpClient httpClient = new SsrfGuardedHttpClient(new AllowAllSsrfGuard());
        StepExecutor executor = new StepExecutor(httpClient, new TemplateResolver(), new AssertionFactory(),
                "http://localhost:" + port);

        List<StepResult> steps = executor.run(spec);
        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(steps);

        assertEquals(25, scored.score());
    }
}
