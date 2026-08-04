package com.practiceplatform.validationengine.yaml;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.dataformat.yaml.YAMLMapper;
import com.practiceplatform.validationengine.engine.ChallengeSpec;

import java.io.IOException;

public class ChallengeYamlParser {

    private final YAMLMapper mapper;

    public ChallengeYamlParser() {
        this.mapper = YAMLMapper.builder()
                .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .build();
    }

    public ChallengeSpec parse(String yamlText) throws IOException {
        return mapper.readValue(yamlText, ChallengeSpec.class);
    }
}
