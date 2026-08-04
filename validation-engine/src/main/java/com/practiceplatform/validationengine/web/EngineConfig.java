package com.practiceplatform.validationengine.web;

import com.practiceplatform.validationengine.engine.WebhookNotifier;
import com.practiceplatform.validationengine.http.SsrfGuard;
import com.practiceplatform.validationengine.http.SsrfGuardedHttpClient;
import com.practiceplatform.validationengine.yaml.ChallengeYamlParser;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class EngineConfig {

    @Bean
    public ChallengeYamlParser challengeYamlParser() {
        return new ChallengeYamlParser();
    }

    @Bean
    public SsrfGuardedHttpClient ssrfGuardedHttpClient() {
        return new SsrfGuardedHttpClient(new SsrfGuard());
    }

    @Bean
    public WebhookNotifier webhookNotifier() {
        return new WebhookNotifier();
    }
}
