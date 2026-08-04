package com.practiceplatform.validationengine.web;

public record RunRequest(String jobId, String targetUrl, String challengeYaml, String webhookUrl) {}
