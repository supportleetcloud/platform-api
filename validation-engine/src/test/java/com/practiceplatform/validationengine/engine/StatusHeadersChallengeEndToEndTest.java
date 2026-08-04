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
