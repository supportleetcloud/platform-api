package com.practiceplatform.validationengine.engine;

import java.util.Map;

public class CheckSpec {
    private String name;
    private RequestSpec request;
    private ExpectSpec expect;
    private int points;

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public RequestSpec getRequest() { return request; }
    public void setRequest(RequestSpec request) { this.request = request; }
    public ExpectSpec getExpect() { return expect; }
    public void setExpect(ExpectSpec expect) { this.expect = expect; }
    public int getPoints() { return points; }
    public void setPoints(int points) { this.points = points; }

    public static class RequestSpec {
        private String method;
        private String path;
        private Map<String, String> headers;
        private Map<String, Object> body;

        public String getMethod() { return method; }
        public void setMethod(String method) { this.method = method; }
        public String getPath() { return path; }
        public void setPath(String path) { this.path = path; }
        public Map<String, String> getHeaders() { return headers; }
        public void setHeaders(Map<String, String> headers) { this.headers = headers; }
        public Map<String, Object> getBody() { return body; }
        public void setBody(Map<String, Object> body) { this.body = body; }
    }

    public static class ExpectSpec {
        private Integer status;
        private Map<String, Object> json;
        private Map<String, String> headers;
        private String jsonSchema;
        private Map<String, Object> jwtClaims;
        private Boolean matchesOpenApi;

        public Integer getStatus() { return status; }
        public void setStatus(Integer status) { this.status = status; }
        public Map<String, Object> getJson() { return json; }
        public void setJson(Map<String, Object> json) { this.json = json; }
        public Map<String, String> getHeaders() { return headers; }
        public void setHeaders(Map<String, String> headers) { this.headers = headers; }
        public String getJsonSchema() { return jsonSchema; }
        public void setJsonSchema(String jsonSchema) { this.jsonSchema = jsonSchema; }
        public Map<String, Object> getJwtClaims() { return jwtClaims; }
        public void setJwtClaims(Map<String, Object> jwtClaims) { this.jwtClaims = jwtClaims; }
        public Boolean getMatchesOpenApi() { return matchesOpenApi; }
        public void setMatchesOpenApi(Boolean matchesOpenApi) { this.matchesOpenApi = matchesOpenApi; }
    }
}
