package com.practiceplatform.validationengine.engine;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class RunResult {
    private String jobId;
    private String status;
    private Integer score;
    private List<ScoreCalculator.CheckResult> checks;
    private String error;

    private RunResult() {}

    public static RunResult completed(String jobId, ScoreCalculator.ScoredRun scored) {
        RunResult result = new RunResult();
        result.jobId = jobId;
        result.status = "completed";
        result.score = scored.score();
        result.checks = scored.checks();
        return result;
    }

    public static RunResult error(String jobId, String message) {
        RunResult result = new RunResult();
        result.jobId = jobId;
        result.status = "error";
        result.error = message;
        return result;
    }

    public String getJobId() { return jobId; }
    public String getStatus() { return status; }
    public Integer getScore() { return score; }
    public List<ScoreCalculator.CheckResult> getChecks() { return checks; }
    public String getError() { return error; }
}
