package com.practiceplatform.validationengine.engine;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class TemplateResolver {

    private static final Pattern TOKEN = Pattern.compile("\\{\\{\\s*(.+?)\\s*}}");
    private static final Pattern EXPR = Pattern.compile("steps\\[(\\d+)]\\.response\\.(.+)");

    public static class ResolutionException extends Exception {
        public ResolutionException(String reason) { super(reason); }
    }

    public String resolveString(String template, List<StepResult> priorSteps) throws ResolutionException {
        if (template == null) return null;
        Matcher matcher = TOKEN.matcher(template);
        StringBuilder result = new StringBuilder();
        int last = 0;
        while (matcher.find()) {
            result.append(template, last, matcher.start());
            result.append(resolveExpression(matcher.group(1), priorSteps));
            last = matcher.end();
        }
        result.append(template.substring(last));
        return result.toString();
    }

    public Map<String, String> resolveHeaders(Map<String, String> headers, List<StepResult> priorSteps)
            throws ResolutionException {
        if (headers == null) return Map.of();
        Map<String, String> resolved = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            resolved.put(entry.getKey(), resolveString(entry.getValue(), priorSteps));
        }
        return resolved;
    }

    @SuppressWarnings("unchecked")
    public Object resolveBody(Object body, List<StepResult> priorSteps) throws ResolutionException {
        if (body instanceof String s) {
            return resolveString(s, priorSteps);
        }
        if (body instanceof Map<?, ?> map) {
            Map<String, Object> resolved = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                resolved.put((String) entry.getKey(), resolveBody(entry.getValue(), priorSteps));
            }
            return resolved;
        }
        if (body instanceof List<?> list) {
            List<Object> resolved = new java.util.ArrayList<>();
            for (Object item : list) {
                resolved.add(resolveBody(item, priorSteps));
            }
            return resolved;
        }
        return body;
    }

    private String resolveExpression(String expression, List<StepResult> priorSteps) throws ResolutionException {
        Matcher matcher = EXPR.matcher(expression);
        if (!matcher.matches()) {
            throw new ResolutionException("unrecognized template expression: " + expression);
        }
        int index = Integer.parseInt(matcher.group(1));
        String path = matcher.group(2);

        if (index < 0 || index >= priorSteps.size()) {
            throw new ResolutionException("step index out of range: " + index);
        }
        StepResult step = priorSteps.get(index);
        StepResult.Response response = step.response();
        if (response == null) {
            throw new ResolutionException("step " + index + " has no response (status=" + step.status() + ")");
        }

        if (path.equals("status")) {
            return String.valueOf(response.status());
        }
        if (path.startsWith("headers.")) {
            String headerName = path.substring("headers.".length());
            String value = response.header(headerName);
            if (value == null) {
                throw new ResolutionException("step " + index + " response has no header: " + headerName);
            }
            return value;
        }
        if (path.startsWith("json.")) {
            String jsonPath = path.substring("json.".length());
            JsonNode node;
            try {
                node = response.json();
            } catch (Exception e) {
                throw new ResolutionException("step " + index + " response body is not valid JSON");
            }
            if (node == null) {
                throw new ResolutionException("step " + index + " response body is empty");
            }
            for (String segment : jsonPath.split("\\.")) {
                node = node.get(segment);
                if (node == null) {
                    throw new ResolutionException("step " + index + " response JSON has no field: " + jsonPath);
                }
            }
            return node.isTextual() ? node.asText() : node.toString();
        }
        throw new ResolutionException("unrecognized response path: " + path);
    }
}
