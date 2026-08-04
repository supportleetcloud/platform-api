package com.practiceplatform.validationengine.engine;

import java.util.List;

public class ChallengeSpec {
    private String id;
    private String title;
    private String category;
    private String openapiSpec;
    private List<CheckSpec> checks;

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getCategory() { return category; }
    public void setCategory(String category) { this.category = category; }
    public String getOpenapiSpec() { return openapiSpec; }
    public void setOpenapiSpec(String openapiSpec) { this.openapiSpec = openapiSpec; }
    public List<CheckSpec> getChecks() { return checks; }
    public void setChecks(List<CheckSpec> checks) { this.checks = checks; }
}
