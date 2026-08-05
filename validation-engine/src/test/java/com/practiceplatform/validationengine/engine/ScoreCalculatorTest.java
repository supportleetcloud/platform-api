package com.practiceplatform.validationengine.engine;

import com.practiceplatform.validationengine.assertions.AssertionResult;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class ScoreCalculatorTest {

    private StepResult passedStep(String name, int points) {
        StepResult step = StepResult.forExecuted(name, points,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(200, Map.of(), "{}"));
        step.addAssertionResult(new AssertionResult("status", true, "ok"));
        step.finalizeStatus();
        return step;
    }

    private StepResult failedStep(String name, int points) {
        StepResult step = StepResult.forExecuted(name, points,
                new StepResult.ResolvedRequest("GET", "/x", Map.of(), null),
                new StepResult.Response(500, Map.of(), "{}"));
        step.addAssertionResult(new AssertionResult("status", false, "expected 200 but got 500"));
        step.finalizeStatus();
        return step;
    }

    @Test
    void scoresOneHundredWhenAllChecksPass() {
        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(
                List.of(passedStep("a", 10), passedStep("b", 5)));

        assertEquals(100, scored.score());
    }

    @Test
    void computesPartialScoreFromMixedResults() {
        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(
                List.of(passedStep("a", 10), failedStep("b", 10), passedStep("c", 5)));

        assertEquals(60, scored.score());
    }

    @Test
    void mapsErrorStepsToFailedWithZeroPointsEarned() {
        StepResult errored = StepResult.error("a", 10, "connection refused");

        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(List.of(errored));

        assertEquals(0, scored.score());
        assertEquals("failed", scored.checks().get(0).status());
        assertEquals(0, scored.checks().get(0).pointsEarned());
        assertEquals("connection refused", scored.checks().get(0).reason());
    }

    @Test
    void mapsSkippedStepsWithZeroPointsEarned() {
        StepResult skipped = StepResult.skipped("a", 10, "step index out of range: 5");

        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(List.of(skipped));

        assertEquals("skipped", scored.checks().get(0).status());
        assertEquals(0, scored.checks().get(0).pointsEarned());
        assertEquals("step index out of range: 5", scored.checks().get(0).reason());
    }

    @Test
    void reasonIsNullForNormallyEvaluatedPassedCheck() {
        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(List.of(passedStep("a", 10)));

        assertNull(scored.checks().get(0).reason());
    }

    @Test
    void scoresZeroWhenChallengeHasNoPoints() {
        ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(List.of(passedStep("a", 0)));

        assertEquals(0, scored.score());
    }
}
