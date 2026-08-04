package com.practiceplatform.validationengine.engine;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.practiceplatform.validationengine.assertions.Assertion;
import com.practiceplatform.validationengine.assertions.AssertionFactory;
import com.practiceplatform.validationengine.http.SsrfGuardedHttpClient;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class StepExecutor {

    private final SsrfGuardedHttpClient httpClient;
    private final TemplateResolver templateResolver;
    private final AssertionFactory assertionFactory;
    private final String targetBaseUrl;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public StepExecutor(SsrfGuardedHttpClient httpClient, TemplateResolver templateResolver,
                         AssertionFactory assertionFactory, String targetBaseUrl) {
        this.httpClient = httpClient;
        this.templateResolver = templateResolver;
        this.assertionFactory = assertionFactory;
        this.targetBaseUrl = targetBaseUrl;
    }

    public List<StepResult> run(ChallengeSpec spec) {
        List<StepResult> steps = new ArrayList<>();
        for (CheckSpec check : spec.getChecks()) {
            steps.add(executeOne(check, spec.getOpenapiSpec(), steps));
        }
        return steps;
    }

    private StepResult executeOne(CheckSpec check, String openapiSpecPath, List<StepResult> priorSteps) {
        String path;
        Map<String, String> headers;
        Object body;
        try {
            path = templateResolver.resolveString(check.getRequest().getPath(), priorSteps);
            headers = templateResolver.resolveHeaders(check.getRequest().getHeaders(), priorSteps);
            body = templateResolver.resolveBody(check.getRequest().getBody(), priorSteps);
        } catch (TemplateResolver.ResolutionException e) {
            return StepResult.skipped(check.getName(), check.getPoints(), e.getMessage());
        }

        String method = check.getRequest().getMethod();
        String url = targetBaseUrl + path;
        String bodyJson;
        try {
            bodyJson = body == null ? null : objectMapper.writeValueAsString(body);
        } catch (JsonProcessingException e) {
            return StepResult.error(check.getName(), check.getPoints(),
                    "failed to serialize request body: " + e.getMessage());
        }

        SsrfGuardedHttpClient.RawResponse raw;
        try {
            raw = httpClient.send(method, url, headers, bodyJson);
        } catch (Exception e) {
            return StepResult.error(check.getName(), check.getPoints(), e.getMessage());
        }

        StepResult.ResolvedRequest resolvedRequest = new StepResult.ResolvedRequest(method, path, headers, body);
        StepResult.Response response = new StepResult.Response(raw.status(), raw.headers(), raw.body());
        StepResult result = StepResult.forExecuted(check.getName(), check.getPoints(), resolvedRequest, response);

        for (Assertion assertion : assertionFactory.build(check.getExpect(), openapiSpecPath)) {
            result.addAssertionResult(assertion.evaluate(result));
        }
        result.finalizeStatus();
        return result;
    }
}
