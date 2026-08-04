package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StatusAssertionTest {

    @Test
    void passesWhenStatusMatches() {
        StepResult step = StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(200, Map.of(), "{}"));

        assertTrue(new StatusAssertion(200).evaluate(step).passed());
    }

    @Test
    void failsWhenStatusDiffers() {
        StepResult step = StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(404, Map.of(), "{}"));

        assertFalse(new StatusAssertion(200).evaluate(step).passed());
    }
}
