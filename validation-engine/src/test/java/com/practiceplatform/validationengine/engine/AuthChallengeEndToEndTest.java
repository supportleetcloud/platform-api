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
