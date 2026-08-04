package com.practiceplatform.validationengine.assertions;

import com.atlassian.oai.validator.OpenApiInteractionValidator;
import com.atlassian.oai.validator.model.SimpleRequest;
import com.atlassian.oai.validator.model.SimpleResponse;
import com.atlassian.oai.validator.report.ValidationReport;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.practiceplatform.validationengine.engine.StepResult;

import java.net.URL;

public class OpenApiAssertion implements Assertion {
    private static final ObjectMapper JSON = new ObjectMapper();

    private final String openapiSpecPath;

    public OpenApiAssertion(String openapiSpecPath) {
        this.openapiSpecPath = openapiSpecPath;
    }

    @Override
    public AssertionResult evaluate(StepResult step) {
        if (openapiSpecPath == null) {
            return new AssertionResult("matchesOpenApi", false, "challenge has no openapiSpec configured");
        }
        URL specUrl = getClass().getResource("/" + openapiSpecPath);
        if (specUrl == null) {
            return new AssertionResult("matchesOpenApi", false,
                    "OpenAPI spec not found on classpath: /" + openapiSpecPath);
        }

        try {
            OpenApiInteractionValidator validator = OpenApiInteractionValidator
                    .createFor(specUrl.toString())
                    .build();

            SimpleRequest.Builder requestBuilder =
                    new SimpleRequest.Builder(step.request().method(), step.request().path());
            step.request().headers().forEach(requestBuilder::withHeader);
            if (step.request().body() != null) {
                try {
                    requestBuilder.withBody(JSON.writeValueAsString(step.request().body()));
                } catch (Exception e) {
                    return new AssertionResult("matchesOpenApi", false, "failed to serialize request body");
                }
            }

            SimpleResponse.Builder responseBuilder = new SimpleResponse.Builder(step.response().status());
            String responseContentType = step.response().header("Content-Type");
            if (responseContentType != null) {
                responseBuilder.withContentType(responseContentType);
            }
            if (step.response().bodyRaw() != null) {
                responseBuilder.withBody(step.response().bodyRaw());
            }

            ValidationReport report = validator.validate(requestBuilder.build(), responseBuilder.build());
            if (!report.hasErrors()) {
                return new AssertionResult("matchesOpenApi", true, "request/response conform to OpenAPI spec");
            }
            return new AssertionResult("matchesOpenApi", false, "OpenAPI violations: " + report.getMessages());
        } catch (Exception e) {
            return new AssertionResult("matchesOpenApi", false, "OpenAPI validation error: " + e.getMessage());
        }
    }
}
