package com.practiceplatform.validationengine.http;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.UnknownHostException;
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
    void abortsWhenRedirectPointsAtBlockedHostUsingTheRealGuard() throws Exception {
        // Unlike followsRedirectChainToFinalResponse() above (which uses AllowAllSsrfGuard and so
        // never actually exercises SsrfGuard's real address-range logic on a redirect hop), this
        // proves the guard's per-hop re-check genuinely rejects a redirect target that resolves to
        // a blocked range -- using the REAL SsrfGuard, not a permissive test double.
        //
        // The initial hop necessarily targets this JVM's own embedded test server, which can only
        // ever bind to a loopback/private address -- itself something the real guard blocks. To
        // isolate "the redirect hop gets re-checked and rejected" from "the very first hop is
        // rejected", RealGuardExceptForTestServerHost allows exactly the literal host string used
        // for hop 0 ("localhost") as a test-harness carve-out, and delegates every other host --
        // including whatever the redirect's Location header points at -- to a real, unmodified
        // SsrfGuard instance. The redirect below points at the IP literal "127.0.0.1", a different
        // host string than "localhost" even though both resolve to the same loopback address, so
        // the real guard's unmodified isBlocked()/check() logic is what rejects hop 1.
        server.createContext("/start", exchange -> {
            exchange.getResponseHeaders().add("Location", "http://127.0.0.1:" + port + "/end");
            exchange.sendResponseHeaders(302, -1);
            exchange.close();
        });
        server.createContext("/end", exchange -> {
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });

        SsrfGuardedHttpClient client = new SsrfGuardedHttpClient(new RealGuardExceptForTestServerHost("localhost"));

        SsrfGuardedHttpClient.BlockedTargetException ex = assertThrows(
                SsrfGuardedHttpClient.BlockedTargetException.class,
                () -> client.send("GET", "http://localhost:" + port + "/start", Map.of(), null));
        assertTrue(ex.getMessage().contains("blocked target"));
        assertTrue(ex.getMessage().contains("127.0.0.1"));
    }

    /**
     * A REAL {@link SsrfGuard} for every host except one exact, test-harness-only carve-out (this
     * JVM's own embedded test server, which can only ever bind to a loopback/private address). All
     * other hosts -- notably a redirect target -- are decided by an unmodified, delegate SsrfGuard.
     * This is intentionally much narrower than {@link AllowAllSsrfGuard}: it does not weaken the
     * property under test (does the guard correctly reject a blocked redirect target?) at all.
     */
    private static class RealGuardExceptForTestServerHost extends SsrfGuard {
        private final String allowedTestServerHost;
        private final SsrfGuard realGuard = new SsrfGuard();

        RealGuardExceptForTestServerHost(String allowedTestServerHost) {
            this.allowedTestServerHost = allowedTestServerHost;
        }

        @Override
        public void check(String host) throws BlockedHostException, UnknownHostException {
            if (allowedTestServerHost.equalsIgnoreCase(host)) {
                return;
            }
            realGuard.check(host);
        }
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
