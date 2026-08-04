package com.practiceplatform.validationengine.assertions;

import com.practiceplatform.validationengine.engine.CheckSpec;

import java.util.ArrayList;
import java.util.List;

public class AssertionFactory {

    public List<Assertion> build(CheckSpec.ExpectSpec expect, String openapiSpecPath) {
        List<Assertion> assertions = new ArrayList<>();
        if (expect.getStatus() != null) {
            assertions.add(new StatusAssertion(expect.getStatus()));
        }
        if (expect.getHeaders() != null) {
            assertions.add(new HeaderAssertion(expect.getHeaders()));
        }
        if (expect.getJson() != null) {
            assertions.add(new JsonAssertion(expect.getJson()));
        }
        if (expect.getJwtClaims() != null) {
            assertions.add(new JwtClaimsAssertion(expect.getJwtClaims()));
        }
        if (expect.getJsonSchema() != null) {
            assertions.add(new JsonSchemaAssertion(expect.getJsonSchema()));
        }
        if (Boolean.TRUE.equals(expect.getMatchesOpenApi())) {
            assertions.add(new OpenApiAssertion(openapiSpecPath));
        }
        return assertions;
    }
}
