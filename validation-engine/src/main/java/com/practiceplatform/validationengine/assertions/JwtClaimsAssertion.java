package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;

import java.util.Map;

public class JwtClaimsAssertion implements Assertion {
    public JwtClaimsAssertion(Map<String, Object> expectedClaims) {}

    @Override
    public AssertionResult evaluate(StepResult step) {
        throw new UnsupportedOperationException("implemented in Task 8");
    }
}
