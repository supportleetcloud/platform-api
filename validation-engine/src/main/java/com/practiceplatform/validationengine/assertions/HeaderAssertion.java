package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;

import java.util.Map;
import java.util.regex.Pattern;

public class HeaderAssertion implements Assertion {
    private final Map<String, String> expected;

    public HeaderAssertion(Map<String, String> expected) { this.expected = expected; }

    @Override
    public AssertionResult evaluate(StepResult step) {
        for (Map.Entry<String, String> entry : expected.entrySet()) {
            String name = entry.getKey();
            String rule = entry.getValue();
            String actual = step.response().header(name);

            if ("exists".equals(rule)) {
                if (actual == null) {
                    return new AssertionResult("headers", false, "header missing: " + name);
                }
                continue;
            }
            if (rule.startsWith("regex:")) {
                String pattern = rule.substring("regex:".length());
                if (actual == null || !Pattern.matches(pattern, actual)) {
                    return new AssertionResult("headers", false,
                            "header " + name + " did not match " + pattern + " (was: " + actual + ")");
                }
                continue;
            }
            if (!rule.equals(actual)) {
                return new AssertionResult("headers", false,
                        "header " + name + " expected " + rule + " but got " + actual);
            }
        }
        return new AssertionResult("headers", true, "all headers matched");
    }
}
