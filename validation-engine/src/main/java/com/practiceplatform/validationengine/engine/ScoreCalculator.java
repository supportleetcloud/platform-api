package com.practiceplatform.validationengine.engine;

import java.util.List;

public class ScoreCalculator {

    public record AssertionDto(String type, boolean passed, String detail) {}

    public record CheckResult(String name, String status, int points, int pointsEarned,
                               List<AssertionDto> assertions) {}

    public record ScoredRun(int score, List<CheckResult> checks) {}

    public ScoredRun calculate(List<StepResult> steps) {
        int totalPoints = steps.stream().mapToInt(StepResult::points).sum();
        int earnedPoints = steps.stream()
                .filter(s -> s.status() == StepResult.Status.PASSED)
                .mapToInt(StepResult::points)
                .sum();
        int score = totalPoints == 0 ? 0 : Math.round(100f * earnedPoints / totalPoints);

        List<CheckResult> checks = steps.stream().map(this::toCheckResult).toList();
        return new ScoredRun(score, checks);
    }

    private CheckResult toCheckResult(StepResult step) {
        String status = switch (step.status()) {
            case PASSED -> "passed";
            case FAILED, ERROR -> "failed";
            case SKIPPED -> "skipped";
        };
        int pointsEarned = step.status() == StepResult.Status.PASSED ? step.points() : 0;
        List<AssertionDto> assertions = step.assertions().stream()
                .map(a -> new AssertionDto(a.type(), a.passed(), a.detail()))
                .toList();
        return new CheckResult(step.checkName(), status, step.points(), pointsEarned, assertions);
    }
}
