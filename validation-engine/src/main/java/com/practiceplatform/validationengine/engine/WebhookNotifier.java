package com.practiceplatform.validationengine.engine;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

public class WebhookNotifier {

    private static final Logger log = LoggerFactory.getLogger(WebhookNotifier.class);

    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;

    public WebhookNotifier() {
        this.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        this.objectMapper = new ObjectMapper();
    }

    public void notify(String webhookUrl, RunResult result) throws IOException, InterruptedException {
        String json = objectMapper.writeValueAsString(result);
        HttpRequest request = HttpRequest.newBuilder(URI.create(webhookUrl))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(10))
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build();
        HttpResponse<Void> response = httpClient.send(request, HttpResponse.BodyHandlers.discarding());
        int statusCode = response.statusCode();
        if (statusCode < 200 || statusCode >= 300) {
            log.warn("webhook delivery to {} returned non-2xx status {}", webhookUrl, statusCode);
        }
    }
}
