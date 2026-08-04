package com.practiceplatform.validationengine.assertions;

import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import com.practiceplatform.validationengine.engine.StepResult;

import java.io.InputStream;
import java.util.List;

public class JsonSchemaAssertion implements Assertion {
    private static final SchemaRegistry REGISTRY = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12);

    private final String schemaClasspathPath;

    public JsonSchemaAssertion(String schemaClasspathPath) {
        this.schemaClasspathPath = schemaClasspathPath;
    }

    @Override
    public AssertionResult evaluate(StepResult step) {
        String bodyRaw = step.response().bodyRaw();
        try {
            if (step.response().json() == null) {
                return new AssertionResult("jsonSchema", false, "response body is empty");
            }
        } catch (Exception e) {
            return new AssertionResult("jsonSchema", false, "response body is not valid JSON");
        }

        String resourcePath = "/challenges/" + schemaClasspathPath;
        try (InputStream in = getClass().getResourceAsStream(resourcePath)) {
            if (in == null) {
                return new AssertionResult("jsonSchema", false, "schema not found on classpath: " + resourcePath);
            }
            Schema schema = REGISTRY.getSchema(in);
            List<com.networknt.schema.Error> errors = schema.validate(bodyRaw, InputFormat.JSON);
            if (errors.isEmpty()) {
                return new AssertionResult("jsonSchema", true, "response body matches schema");
            }
            return new AssertionResult("jsonSchema", false, "schema violations: " + errors);
        } catch (Exception e) {
            return new AssertionResult("jsonSchema", false, "schema validation error: " + e.getMessage());
        }
    }
}
