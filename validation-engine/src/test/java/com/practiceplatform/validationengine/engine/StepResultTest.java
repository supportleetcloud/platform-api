package com.practiceplatform.validationengine.engine;

import com.practiceplatform.validationengine.assertions.AssertionResult;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class StepResultTest {

    @Test
    void finalizeStatusFailsWhenNoAssertionsWereAdded() {
        // Zero assertions means the check's `expect` block produced no recognized assertions
        // (e.g. an empty `expect: {}`). allMatch() on an empty stream is vacuously true, which
        // must NOT be interpreted as "everything passed" -- that would silently score an
        // unverified check as PASSED.
        StepResult step = StepResult.forExecuted("no assertions configured", 10,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(200, Map.of(), "{}"));

        step.finalizeStatus();

        assertEquals(StepResult.Status.FAILED, step.status());
    }

    @Test
    void finalizeStatusPassesWhenAllAddedAssertionsPassed() {
        StepResult step = StepResult.forExecuted("has assertions", 10,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(200, Map.of(), "{}"));
        step.addAssertionResult(new AssertionResult("status", true, "ok"));

        step.finalizeStatus();

        assertEquals(StepResult.Status.PASSED, step.status());
    }

    @Test
    void finalizeStatusFailsWhenAnyAddedAssertionFailed() {
        StepResult step = StepResult.forExecuted("has failing assertion", 10,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(500, Map.of(), "{}"));
        step.addAssertionResult(new AssertionResult("status", false, "expected 200 but got 500"));

        step.finalizeStatus();

        assertEquals(StepResult.Status.FAILED, step.status());
    }
}
