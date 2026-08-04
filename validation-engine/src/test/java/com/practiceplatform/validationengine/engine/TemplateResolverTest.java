package com.practiceplatform.validationengine.engine;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class TemplateResolverTest {

    private final TemplateResolver resolver = new TemplateResolver();

    private StepResult stepWithJsonBody(String body) {
        return StepResult.forExecuted("check", 10,
                new StepResult.ResolvedRequest("POST", "/todos", Map.of(), null),
                new StepResult.Response(201, Map.of("Location", "/todos/1"), body));
    }

    @Test
    void resolvesJsonFieldFromPriorStep() throws TemplateResolver.ResolutionException {
        List<StepResult> steps = List.of(stepWithJsonBody("{\"id\":\"abc123\"}"));

        String resolved = resolver.resolveString("/todos/{{steps[0].response.json.id}}", steps);

        assertEquals("/todos/abc123", resolved);
    }

    @Test
    void resolvesHeaderFromPriorStep() throws TemplateResolver.ResolutionException {
        List<StepResult> steps = List.of(stepWithJsonBody("{}"));

        String resolved = resolver.resolveString("{{steps[0].response.headers.Location}}", steps);

        assertEquals("/todos/1", resolved);
    }

    @Test
    void resolvesStatusFromPriorStep() throws TemplateResolver.ResolutionException {
        List<StepResult> steps = List.of(stepWithJsonBody("{}"));

        String resolved = resolver.resolveString("{{steps[0].response.status}}", steps);

        assertEquals("201", resolved);
    }

    @Test
    void passesThroughStringsWithNoTemplate() throws TemplateResolver.ResolutionException {
        assertEquals("/todos", resolver.resolveString("/todos", List.of()));
    }

    @Test
    void throwsResolutionExceptionOnOutOfRangeIndex() {
        assertThrows(TemplateResolver.ResolutionException.class,
                () -> resolver.resolveString("{{steps[0].response.status}}", List.of()));
    }

    @Test
    void throwsResolutionExceptionOnMissingJsonField() {
        List<StepResult> steps = List.of(stepWithJsonBody("{\"id\":\"abc123\"}"));

        assertThrows(TemplateResolver.ResolutionException.class,
                () -> resolver.resolveString("{{steps[0].response.json.missing}}", steps));
    }

    @Test
    void throwsResolutionExceptionWhenStepHasNoResponse() {
        List<StepResult> steps = List.of(StepResult.error("check", 10, "connection refused"));

        assertThrows(TemplateResolver.ResolutionException.class,
                () -> resolver.resolveString("{{steps[0].response.status}}", steps));
    }

    @Test
    void throwsResolutionExceptionOnNonJsonBody() {
        List<StepResult> steps = List.of(stepWithJsonBody("not-json-at-all"));

        assertThrows(TemplateResolver.ResolutionException.class,
                () -> resolver.resolveString("{{steps[0].response.json.id}}", steps));
    }

    @Test
    @SuppressWarnings("unchecked")
    void resolvesNestedMapBody() throws TemplateResolver.ResolutionException {
        List<StepResult> steps = List.of(stepWithJsonBody("{\"id\":\"abc123\"}"));

        Object resolved = resolver.resolveBody(
                Map.of("todoId", "{{steps[0].response.json.id}}", "note", "static"), steps);

        Map<String, Object> resolvedMap = (Map<String, Object>) resolved;
        assertEquals("abc123", resolvedMap.get("todoId"));
        assertEquals("static", resolvedMap.get("note"));
    }

    @Test
    void resolveHeadersThrowsResolutionExceptionOnOutOfRangeIndex() {
        assertThrows(TemplateResolver.ResolutionException.class,
                () -> resolver.resolveHeaders(Map.of("X-Todo", "{{steps[0].response.status}}"), List.of()));
    }

    @Test
    void resolveBodyThrowsResolutionExceptionOnMissingJsonField() {
        List<StepResult> steps = List.of(stepWithJsonBody("{\"id\":\"abc123\"}"));

        assertThrows(TemplateResolver.ResolutionException.class,
                () -> resolver.resolveBody(Map.of("todoId", "{{steps[0].response.json.missing}}"), steps));
    }

    @Test
    void throwsResolutionExceptionOnOutOfIntRangeIndex() {
        List<StepResult> steps = List.of(stepWithJsonBody("{}"));

        assertThrows(TemplateResolver.ResolutionException.class,
                () -> resolver.resolveString("{{steps[99999999999999999999].response.status}}", steps));
    }
}
