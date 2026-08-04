package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JsonAssertionTest {

    private StepResult stepWithBody(String body) {
        return StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(200, Map.of(), body));
    }

    @Test
    void passesOnPartialMatchIgnoringExtraFields() {
        StepResult step = stepWithBody("{\"title\":\"Buy milk\",\"completed\":false,\"id\":\"1\"}");
        assertTrue(new JsonAssertion(Map.of("title", "Buy milk", "completed", false))
                .evaluate(step).passed());
    }

    @Test
    void existsSentinelOnlyChecksPresence() {
        StepResult step = stepWithBody("{\"id\":\"anything\"}");
        assertTrue(new JsonAssertion(Map.of("id", "exists")).evaluate(step).passed());
    }

    @Test
    void failsWhenFieldMissing() {
        StepResult step = stepWithBody("{\"title\":\"Buy milk\"}");
        assertFalse(new JsonAssertion(Map.of("completed", false)).evaluate(step).passed());
    }

    @Test
    void failsWhenBodyIsNotJson() {
        StepResult step = stepWithBody("not json");
        assertFalse(new JsonAssertion(Map.of("title", "Buy milk")).evaluate(step).passed());
    }
}
