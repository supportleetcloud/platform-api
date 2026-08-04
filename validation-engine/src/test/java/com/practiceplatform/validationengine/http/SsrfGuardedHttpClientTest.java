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
