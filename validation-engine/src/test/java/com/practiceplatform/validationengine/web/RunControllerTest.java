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
