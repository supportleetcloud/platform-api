package com.practiceplatform.validationengine.engine;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.practiceplatform.validationengine.assertions.AssertionResult;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class StepResult {

    public enum Status { PASSED, FAILED, SKIPPED, ERROR }

    private static final ObjectMapper JSON = new ObjectMapper();

    private final String checkName;
    private final int points;
    private final ResolvedRequest request;
    private final Response response;
    private final List<AssertionResult> assertions = new ArrayList<>();
    private Status status;
    private final String reason;

    private StepResult(String checkName, int points, ResolvedRequest request, Response response,
                        Status status, String reason) {
        this.checkName = checkName;
        this.points = points;
        this.request = request;
        this.response = response;
        this.status = status;
        this.reason = reason;
    }

    public static StepResult forExecuted(String checkName, int points, ResolvedRequest request, Response response) {
        return new StepResult(checkName, points, request, response, null, null);
    }

    public static StepResult skipped(String checkName, int points, String reason) {
        return new StepResult(checkName, points, null, null, Status.SKIPPED, reason);
    }

    public static StepResult error(String checkName, int points, String reason) {
        return new StepResult(checkName, points, null, null, Status.ERROR, reason);
    }

    public void addAssertionResult(AssertionResult result) {
        assertions.add(result);
    }

    public void finalizeStatus() {
        // An empty assertions list means the check's `expect` block produced zero recognized
        // assertions (e.g. `expect: {}`, or previously a typo'd key before strict YAML parsing was
        // enforced). allMatch() on an empty stream is vacuously true, which would otherwise score
        // such a check as PASSED with no evidence at all — treat it as FAILED instead.
        this.status = !assertions.isEmpty() && assertions.stream().allMatch(AssertionResult::passed)
                ? Status.PASSED : Status.FAILED;
    }

    public String checkName() { return checkName; }
    public int points() { return points; }
    public ResolvedRequest request() { return request; }
    public Response response() { return response; }
    public List<AssertionResult> assertions() { return assertions; }
    public Status status() { return status; }
    public String reason() { return reason; }

    public record ResolvedRequest(String method, String path, Map<String, String> headers, Object body) {}

    public static final class Response {
        private final int status;
        private final Map<String, String> headers;
        private final String bodyRaw;
        private JsonNode cachedJson;
        private boolean jsonParsed;

        public Response(int status, Map<String, String> headers, String bodyRaw) {
            this.status = status;
            this.headers = headers;
            this.bodyRaw = bodyRaw;
        }

        public int status() { return status; }

        public String header(String name) {
            return headers.entrySet().stream()
                    .filter(e -> e.getKey().equalsIgnoreCase(name))
                    .map(Map.Entry::getValue)
                    .findFirst().orElse(null);
        }

        public String bodyRaw() { return bodyRaw; }

        public JsonNode json() throws JsonProcessingException {
            if (!jsonParsed) {
                cachedJson = (bodyRaw == null || bodyRaw.isBlank()) ? null : JSON.readTree(bodyRaw);
                jsonParsed = true;
            }
            return cachedJson;
        }
    }
}
