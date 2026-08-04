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
