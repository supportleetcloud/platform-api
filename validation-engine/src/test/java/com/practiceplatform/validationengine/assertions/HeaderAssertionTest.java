package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HeaderAssertionTest {

    private StepResult stepWithHeaders(Map<String, String> headers) {
        return StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(200, headers, "{}"));
    }

    @Test
    void passesWhenHeaderExists() {
        StepResult step = stepWithHeaders(Map.of("Location", "/todos/1"));
        assertTrue(new HeaderAssertion(Map.of("Location", "exists")).evaluate(step).passed());
    }

    @Test
    void failsWhenHeaderMissing() {
        StepResult step = stepWithHeaders(Map.of());
        assertFalse(new HeaderAssertion(Map.of("Location", "exists")).evaluate(step).passed());
    }

    @Test
    void passesWhenHeaderMatchesRegex() {
        StepResult step = stepWithHeaders(Map.of("Content-Type", "application/json;charset=UTF-8"));
        assertTrue(new HeaderAssertion(Map.of("Content-Type", "regex:application/json.*"))
                .evaluate(step).passed());
    }

    @Test
    void failsWhenHeaderValueDiffers() {
        StepResult step = stepWithHeaders(Map.of("X-Service", "other-api"));
        assertFalse(new HeaderAssertion(Map.of("X-Service", "todo-api")).evaluate(step).passed());
    }
}
