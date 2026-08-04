package com.practiceplatform.validationengine.engine;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RunResultTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void completedResultOmitsErrorField() throws Exception {
        ScoreCalculator.ScoredRun scored = new ScoreCalculator.ScoredRun(100, List.of());
        RunResult result = RunResult.completed("job-1", scored);

        String json = mapper.writeValueAsString(result);

        assertTrue(json.contains("\"status\":\"completed\""));
        assertTrue(json.contains("\"score\":100"));
        assertFalse(json.contains("\"error\""));
    }

    @Test
    void errorResultOmitsScoreAndChecksFields() throws Exception {
        RunResult result = RunResult.error("job-2", "YAML parse failure: bad indentation");

        String json = mapper.writeValueAsString(result);

        assertTrue(json.contains("\"status\":\"error\""));
        assertTrue(json.contains("YAML parse failure"));
        assertFalse(json.contains("\"score\""));
        assertFalse(json.contains("\"checks\""));
    }
}
