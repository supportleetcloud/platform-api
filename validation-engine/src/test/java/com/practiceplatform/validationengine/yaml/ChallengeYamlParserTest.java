package com.practiceplatform.validationengine.yaml;

import com.practiceplatform.validationengine.engine.ChallengeSpec;
import com.practiceplatform.validationengine.engine.CheckSpec;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

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
}
