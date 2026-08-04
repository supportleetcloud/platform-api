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
