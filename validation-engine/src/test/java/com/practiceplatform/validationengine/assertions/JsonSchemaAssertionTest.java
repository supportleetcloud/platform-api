package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JsonSchemaAssertionTest {

    @Test
    void passesWhenBodyMatchesSchema() {
        StepResult.Response response = new StepResult.Response(200, Map.of("Content-Type", "application/json"),
                "{\"id\":\"1\",\"title\":\"Buy milk\",\"completed\":false}");
        StepResult step = StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/todos/1", Map.of(), null), response);

        assertTrue(new JsonSchemaAssertion("todo-schema.json").evaluate(step).passed());
    }

    @Test
    void failsWhenRequiredFieldMissing() {
        StepResult.Response response = new StepResult.Response(200, Map.of("Content-Type", "application/json"),
                "{\"id\":\"1\",\"title\":\"Buy milk\"}");
        StepResult step = StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/todos/1", Map.of(), null), response);

        assertFalse(new JsonSchemaAssertion("todo-schema.json").evaluate(step).passed());
    }

    @Test
    void failsWhenSchemaNotFoundOnClasspath() {
        StepResult.Response response = new StepResult.Response(200, Map.of(), "{}");
        StepResult step = StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("GET", "/todos/1", Map.of(), null), response);

        assertFalse(new JsonSchemaAssertion("does-not-exist.json").evaluate(step).passed());
    }
}
