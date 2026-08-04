package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class OpenApiAssertionTest {

    @Test
    void passesWhenRequestAndResponseConformToSpec() {
        StepResult.ResolvedRequest request = new StepResult.ResolvedRequest(
                "POST", "/todos", Map.of("Content-Type", "application/json"), Map.of("title", "Buy milk"));
        StepResult.Response response = new StepResult.Response(201, Map.of("Content-Type", "application/json"),
                "{\"id\":\"1\",\"title\":\"Buy milk\",\"completed\":false}");
        StepResult step = StepResult.forExecuted("check", 10, request, response);

        assertTrue(new OpenApiAssertion("openapi/todo-api.yaml").evaluate(step).passed());
    }

    @Test
    void failsWhenResponseMissingRequiredField() {
        StepResult.ResolvedRequest request = new StepResult.ResolvedRequest(
                "POST", "/todos", Map.of("Content-Type", "application/json"), Map.of("title", "Buy milk"));
        StepResult.Response response = new StepResult.Response(201, Map.of("Content-Type", "application/json"),
                "{\"id\":\"1\",\"title\":\"Buy milk\"}");
        StepResult step = StepResult.forExecuted("check", 10, request, response);

        assertFalse(new OpenApiAssertion("openapi/todo-api.yaml").evaluate(step).passed());
    }
}
