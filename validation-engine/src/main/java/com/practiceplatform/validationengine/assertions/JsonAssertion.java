package com.practiceplatform.validationengine.assertions;

import com.fasterxml.jackson.databind.JsonNode;
import com.practiceplatform.validationengine.engine.StepResult;

import java.util.Map;

public class JsonAssertion implements Assertion {
    private final Map<String, Object> expected;

    public JsonAssertion(Map<String, Object> expected) { this.expected = expected; }

    @Override
    public AssertionResult evaluate(StepResult step) {
        JsonNode actual;
        try {
            actual = step.response().json();
        } catch (Exception e) {
            return new AssertionResult("json", false, "response body is not valid JSON");
        }
        if (actual == null) {
            return new AssertionResult("json", false, "response body is empty");
        }
        String mismatch = firstMismatch(expected, actual, "");
        if (mismatch != null) {
            return new AssertionResult("json", false, mismatch);
        }
        return new AssertionResult("json", true, "response body matched expected fields");
    }

    @SuppressWarnings("unchecked")
    private String firstMismatch(Map<String, Object> expectedMap, JsonNode actual, String prefix) {
        for (Map.Entry<String, Object> entry : expectedMap.entrySet()) {
            String key = entry.getKey();
            Object expectedValue = entry.getValue();
            String fieldPath = prefix.isEmpty() ? key : prefix + "." + key;
            JsonNode actualValue = actual.get(key);

            if (actualValue == null) {
                return "field missing: " + fieldPath;
            }
            if ("exists".equals(expectedValue)) {
                continue;
            }
            if (expectedValue instanceof Map<?, ?> nestedExpected) {
                String nestedMismatch = firstMismatch((Map<String, Object>) nestedExpected, actualValue, fieldPath);
                if (nestedMismatch != null) return nestedMismatch;
                continue;
            }
            if (!matchesScalar(expectedValue, actualValue)) {
                return "field " + fieldPath + " expected " + expectedValue + " but got " + actualValue;
            }
        }
        return null;
    }

    private boolean matchesScalar(Object expectedValue, JsonNode actualValue) {
        if (expectedValue instanceof Boolean b) return actualValue.isBoolean() && actualValue.asBoolean() == b;
        if (expectedValue instanceof Number n) return actualValue.isNumber() && actualValue.asDouble() == n.doubleValue();
        return actualValue.isTextual()
                ? actualValue.asText().equals(String.valueOf(expectedValue))
                : String.valueOf(expectedValue).equals(actualValue.toString());
    }
}
