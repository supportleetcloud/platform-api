package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;

public class StatusAssertion implements Assertion {
    private final int expectedStatus;

    public StatusAssertion(int expectedStatus) { this.expectedStatus = expectedStatus; }

    @Override
    public AssertionResult evaluate(StepResult step) {
        int actual = step.response().status();
        boolean passed = actual == expectedStatus;
        String detail = passed
                ? "status is " + actual
                : "expected status " + expectedStatus + " but got " + actual;
        return new AssertionResult("status", passed, detail);
    }
}
