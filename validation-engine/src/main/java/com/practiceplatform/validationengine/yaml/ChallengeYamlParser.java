package com.practiceplatform.validationengine.yaml;

import com.fasterxml.jackson.dataformat.yaml.YAMLMapper;
import com.practiceplatform.validationengine.engine.ChallengeSpec;
import com.practiceplatform.validationengine.engine.CheckSpec;

import java.io.IOException;

public class ChallengeYamlParser {

    /**
     * A challenge YAML parsed structurally fine but is not usable: e.g. a check is missing its
     * {@code request} or {@code expect} block. Executing such a spec would NPE deep inside
     * StepExecutor/AssertionFactory, which -- left uncaught there -- would abort the entire run
     * (including every other, valid check) rather than failing clearly at parse time. Failing fast
     * here means one malformed check produces one clear error instead of destroying the whole run.
     */
    public static class InvalidChallengeException extends IOException {
        public InvalidChallengeException(String message) { super(message); }
    }

    private final YAMLMapper mapper;

    public ChallengeYamlParser() {
        // Challenge YAML is authored content (not end-user input), so strict parsing is the right
        // default: an unrecognized key (e.g. a typo'd `expect` field) must fail loudly at parse time
        // rather than being silently dropped, which would otherwise let a check score as if it had
        // no assertions at all.
        this.mapper = YAMLMapper.builder().build();
    }

    public ChallengeSpec parse(String yamlText) throws IOException {
        ChallengeSpec spec = mapper.readValue(yamlText, ChallengeSpec.class);
        validate(spec);
        return spec;
    }

    private void validate(ChallengeSpec spec) throws InvalidChallengeException {
        if (spec.getChecks() == null || spec.getChecks().isEmpty()) {
            throw new InvalidChallengeException("challenge spec has no checks");
        }
        for (int i = 0; i < spec.getChecks().size(); i++) {
            CheckSpec check = spec.getChecks().get(i);
            String label = "check[" + i + "]" + (check.getName() != null ? " (\"" + check.getName() + "\")" : "");
            if (check.getRequest() == null) {
                throw new InvalidChallengeException(label + " is missing a required 'request' block");
            }
            if (check.getExpect() == null) {
                throw new InvalidChallengeException(label + " is missing a required 'expect' block");
            }
        }
    }
}
