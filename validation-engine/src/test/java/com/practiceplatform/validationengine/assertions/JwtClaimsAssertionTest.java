package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JwtClaimsAssertionTest {

    private String mintToken(String payloadJson) {
        String header = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8));
        String payload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(payloadJson.getBytes(StandardCharsets.UTF_8));
        return header + "." + payload + ".fakesig";
    }

    private StepResult stepWithAuthHeader(String authHeaderValue) {
        return StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/profile", Map.of("Authorization", authHeaderValue), null),
                new StepResult.Response(200, Map.of(), "{}"));
    }

    @Test
    void passesWhenClaimExists() {
        String token = mintToken("{\"sub\":\"test-user\"}");
        StepResult step = stepWithAuthHeader("Bearer " + token);

        assertTrue(new JwtClaimsAssertion(Map.of("sub", "exists")).evaluate(step).passed());
    }

    @Test
    void passesWhenClaimValueMatches() {
        String token = mintToken("{\"sub\":\"test-user\"}");
        StepResult step = stepWithAuthHeader("Bearer " + token);

        assertTrue(new JwtClaimsAssertion(Map.of("sub", "test-user")).evaluate(step).passed());
    }

    @Test
    void failsWhenClaimMissing() {
        String token = mintToken("{\"iat\":123}");
        StepResult step = stepWithAuthHeader("Bearer " + token);

        assertFalse(new JwtClaimsAssertion(Map.of("sub", "exists")).evaluate(step).passed());
    }

    @Test
    void failsWhenNoAuthorizationHeader() {
        StepResult step = StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/profile", Map.of(), null),
                new StepResult.Response(200, Map.of(), "{}"));

        assertFalse(new JwtClaimsAssertion(Map.of("sub", "exists")).evaluate(step).passed());
    }

    @Test
    void failsWhenTokenIsMalformed() {
        StepResult step = stepWithAuthHeader("Bearer not-a-real-token");

        assertFalse(new JwtClaimsAssertion(Map.of("sub", "exists")).evaluate(step).passed());
    }
}
