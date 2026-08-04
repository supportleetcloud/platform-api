package com.practiceplatform.validationengine.assertions;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.practiceplatform.validationengine.engine.StepResult;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;

public class JwtClaimsAssertion implements Assertion {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final Map<String, Object> expectedClaims;

    public JwtClaimsAssertion(Map<String, Object> expectedClaims) {
        this.expectedClaims = expectedClaims;
    }

    @Override
    public AssertionResult evaluate(StepResult step) {
        String authHeader = step.request().headers().entrySet().stream()
                .filter(e -> e.getKey().equalsIgnoreCase("Authorization"))
                .map(Map.Entry::getValue)
                .findFirst().orElse(null);

        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            return new AssertionResult("jwtClaims", false, "no Bearer token on this check's Authorization header");
        }
        String token = authHeader.substring("Bearer ".length());
        String[] parts = token.split("\\.");
        if (parts.length < 2) {
            return new AssertionResult("jwtClaims", false, "malformed JWT: expected header.payload.signature");
        }

        JsonNode claims;
        try {
            byte[] payloadBytes = Base64.getUrlDecoder().decode(parts[1]);
            claims = JSON.readTree(new String(payloadBytes, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new AssertionResult("jwtClaims", false, "failed to decode JWT payload: " + e.getMessage());
        }

        for (Map.Entry<String, Object> entry : expectedClaims.entrySet()) {
            JsonNode actual = claims.get(entry.getKey());
            if (actual == null) {
                return new AssertionResult("jwtClaims", false, "claim missing: " + entry.getKey());
            }
            if ("exists".equals(entry.getValue())) continue;
            String actualText = actual.isTextual() ? actual.asText() : actual.toString();
            if (!String.valueOf(entry.getValue()).equals(actualText)) {
                return new AssertionResult("jwtClaims", false,
                        "claim " + entry.getKey() + " expected " + entry.getValue() + " but got " + actual);
            }
        }
        return new AssertionResult("jwtClaims", true, "all claims matched");
    }
}
