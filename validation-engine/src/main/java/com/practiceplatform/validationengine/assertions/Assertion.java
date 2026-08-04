package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.StepResult;

public interface Assertion {
    AssertionResult evaluate(StepResult step);
}
