package com.practiceplatform.validationengine.yaml;

import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.practiceplatform.validationengine.engine.ChallengeSpec;
import com.practiceplatform.validationengine.engine.CheckSpec;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ChallengeYamlParserTest {

    @Test
    void parsesCrudChallenge() throws IOException {
        String yaml = Files.readString(Path.of("src/test/resources/challenges/todo-api-crud.yaml"));

        ChallengeSpec spec = new ChallengeYamlParser().parse(yaml);

        assertEquals("todo-api-crud", spec.getId());
        assertEquals("crud", spec.getCategory());
        assertNull(spec.getOpenapiSpec());
        assertEquals(3, spec.getChecks().size());

        CheckSpec first = spec.getChecks().get(0);
        assertEquals("POST /todos creates a todo", first.getName());
        assertEquals(10, first.getPoints());
        assertEquals("POST", first.getRequest().getMethod());
        assertEquals("/todos", first.getRequest().getPath());
        assertEquals("application/json", first.getRequest().getHeaders().get("Content-Type"));
        assertEquals("Buy milk", first.getRequest().getBody().get("title"));
        assertEquals(201, first.getExpect().getStatus());
        assertEquals(false, first.getExpect().getJson().get("completed"));
        assertEquals("exists", first.getExpect().getHeaders().get("Location"));

        CheckSpec second = spec.getChecks().get(1);
        assertEquals("/todos/{{steps[0].response.json.id}}", second.getRequest().getPath());
    }

    @Test
    void rejectsUnrecognizedKeyInsideExpectBlockInsteadOfSilentlyIgnoringIt() {
        // A typo'd `expect` key (e.g. "statuss" instead of "status") must fail to parse loudly.
        // If it were silently ignored, the check would end up with zero recognized assertions and
        // -- absent the companion StepResult.finalizeStatus() fix -- would be scored PASSED with
        // full points regardless of the candidate's actual response.
        String yaml = """
                id: typo-in-expect
                title: "Typo in expect key"
                category: crud
                checks:
                  - name: "GET /health"
                    request:
                      method: GET
                      path: /health
                    expect:
                      statuss: 200
                    points: 10
                """;

        ChallengeYamlParser parser = new ChallengeYamlParser();
        assertThrows(UnrecognizedPropertyException.class, () -> parser.parse(yaml));
    }

    @Test
    void rejectsCheckMissingExpectBlockAtParseTimeInsteadOfNpeingDuringExecution() {
        // A check with no `expect:` block would otherwise NPE deep inside
        // AssertionFactory.build()/StepExecutor, uncaught, which aborts the ENTIRE run (destroying
        // every other check's results) instead of failing clearly on just the malformed check.
        // Fail fast and clearly at parse time instead.
        String yaml = """
                id: missing-expect
                title: "Missing expect block"
                category: crud
                checks:
                  - name: "GET /health"
                    request:
                      method: GET
                      path: /health
                    points: 10
                """;

        ChallengeYamlParser parser = new ChallengeYamlParser();
        ChallengeYamlParser.InvalidChallengeException ex = assertThrows(
                ChallengeYamlParser.InvalidChallengeException.class, () -> parser.parse(yaml));
        assertTrue(ex.getMessage().contains("expect"));
    }

    @Test
    void rejectsCheckMissingRequestBlockAtParseTime() {
        String yaml = """
                id: missing-request
                title: "Missing request block"
                category: crud
                checks:
                  - name: "GET /health"
                    expect:
                      status: 200
                    points: 10
                """;

        ChallengeYamlParser parser = new ChallengeYamlParser();
        ChallengeYamlParser.InvalidChallengeException ex = assertThrows(
                ChallengeYamlParser.InvalidChallengeException.class, () -> parser.parse(yaml));
        assertTrue(ex.getMessage().contains("request"));
    }
}
