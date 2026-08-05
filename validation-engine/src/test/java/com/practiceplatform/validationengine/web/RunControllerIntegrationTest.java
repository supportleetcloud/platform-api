package com.practiceplatform.validationengine.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Boots the real Spring context (unlike {@link RunControllerTest}, which hand-builds a
 * {@link com.practiceplatform.validationengine.engine.StepExecutor}-driving controller in
 * standalone MockMvc and wires it with a test double {@code AllowAllSsrfGuard}). This test
 * exercises the actual {@code @RestController}/{@code @Configuration} beans wired the way
 * {@link com.practiceplatform.validationengine.web.EngineConfig} wires them in production --
 * critically, a REAL {@link com.practiceplatform.validationengine.http.SsrfGuard}, not a
 * permissive test double -- so it is the only test proving the production wiring actually
 * blocks a run against a loopback target.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)
@AutoConfigureMockMvc
class RunControllerIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    private HttpServer webhookServer;
    private int webhookPort;
    private final CountDownLatch webhookReceived = new CountDownLatch(1);
    private final AtomicReference<String> webhookBody = new AtomicReference<>();

    @BeforeEach
    void startWebhookServer() throws IOException {
        webhookServer = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        webhookPort = webhookServer.getAddress().getPort();
        webhookServer.createContext("/webhook", exchange -> {
            webhookBody.set(new String(exchange.getRequestBody().readAllBytes()));
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
            webhookReceived.countDown();
        });
        webhookServer.start();
    }

    @AfterEach
    void stopWebhookServer() {
        webhookServer.stop(0);
    }

    @Test
    void blocksRunAgainstLoopbackTargetUrlUsingTheRealSsrfGuard() throws Exception {
        // Nothing needs to be listening on this port: the real SsrfGuard rejects 127.0.0.1 by
        // resolved address before any connection attempt is made, so an unused port is fine.
        int blockedPort;
        try (ServerSocket socket = new ServerSocket(0)) {
            blockedPort = socket.getLocalPort();
        }

        String yaml = """
                id: blocked-target-check
                title: "Blocked target check"
                category: crud
                checks:
                  - name: "GET / should never reach a loopback target"
                    request:
                      method: GET
                      path: /
                    expect:
                      status: 200
                    points: 10
                """;

        ObjectMapper objectMapper = new ObjectMapper();
        String requestBody = objectMapper.writeValueAsString(new RunRequest(
                "job-ssrf-1",
                "http://127.0.0.1:" + blockedPort,
                yaml,
                "http://localhost:" + webhookPort + "/webhook"));

        mockMvc.perform(post("/runs")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(requestBody))
                .andExpect(status().isAccepted());

        assertTrue(webhookReceived.await(5, TimeUnit.SECONDS));
        String body = webhookBody.get();

        // The run itself completes (the malformed/blocked check doesn't abort the whole run), but
        // the individual check must show a blocked/failed outcome -- never a successful score.
        assertTrue(body.contains("\"status\":\"completed\""));
        assertTrue(body.contains("\"score\":0"));
        assertTrue(body.contains("\"status\":\"failed\""));
        assertTrue(body.toLowerCase().contains("blocked target"));
        assertFalse(body.contains("\"score\":100"));
    }
}
