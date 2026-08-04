package com.practiceplatform.validationengine.web;

import com.practiceplatform.validationengine.assertions.AssertionFactory;
import com.practiceplatform.validationengine.engine.ChallengeSpec;
import com.practiceplatform.validationengine.engine.RunResult;
import com.practiceplatform.validationengine.engine.ScoreCalculator;
import com.practiceplatform.validationengine.engine.StepExecutor;
import com.practiceplatform.validationengine.engine.StepResult;
import com.practiceplatform.validationengine.engine.TemplateResolver;
import com.practiceplatform.validationengine.engine.WebhookNotifier;
import com.practiceplatform.validationengine.http.SsrfGuardedHttpClient;
import com.practiceplatform.validationengine.yaml.ChallengeYamlParser;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@RestController
public class RunController {

    private final ChallengeYamlParser parser;
    private final SsrfGuardedHttpClient httpClient;
    private final WebhookNotifier webhookNotifier;
    private final ExecutorService executor;

    public RunController(ChallengeYamlParser parser, SsrfGuardedHttpClient httpClient, WebhookNotifier webhookNotifier) {
        this.parser = parser;
        this.httpClient = httpClient;
        this.webhookNotifier = webhookNotifier;
        this.executor = Executors.newVirtualThreadPerTaskExecutor();
    }

    @PostMapping("/runs")
    public ResponseEntity<RunAccepted> run(@RequestBody RunRequest request) {
        executor.submit(() -> processRun(request));
        return ResponseEntity.accepted().body(new RunAccepted(request.jobId(), "accepted"));
    }

    private void processRun(RunRequest request) {
        RunResult result;
        try {
            ChallengeSpec spec = parser.parse(request.challengeYaml());
            StepExecutor stepExecutor = new StepExecutor(
                    httpClient, new TemplateResolver(), new AssertionFactory(), request.targetUrl());
            List<StepResult> steps = stepExecutor.run(spec);
            ScoreCalculator.ScoredRun scored = new ScoreCalculator().calculate(steps);
            result = RunResult.completed(request.jobId(), scored);
        } catch (Exception e) {
            result = RunResult.error(request.jobId(), e.getMessage());
        }

        try {
            webhookNotifier.notify(request.webhookUrl(), result);
        } catch (Exception ignored) {
        }
    }
}
