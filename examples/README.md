# Example contribution standard

English | [中文](README_ZH.md)

Examples demonstrate integrations and scenarios built on qwen-audio-agent. This
document defines their README requirements and review criteria. It applies to new
examples; existing examples should align when their documentation or integration
is substantially updated. It does not claim that all existing examples already comply.

## Files and language

- Place each example in `examples/<lowercase-kebab-case>/`.
- Provide `README.md` in English and `README_ZH.md` in Chinese, with reciprocal
  language links below the title.
- Use the eight sections below, in the same order and with the corresponding
  headings. Put a short project introduction directly below the language links;
  it does not need a separate heading.
- Keep features, requirements, commands, defaults, limitations, and attribution
  consistent between languages. Translate prose, not identifiers or commands.
- Use concise, factual language. Link to detailed documentation instead of
  duplicating it. Demos, screenshots, and benchmark results may be subsections
  of the relevant section; they do not replace the required content.
- If a requirement does not apply, say so briefly rather than inventing a
  capability. Configuration examples must use placeholders, never real secrets.

## Required README structure

### 1. Project overview / 项目简介

Below the title and language links, explain what the example does, the user
scenario, and which framework extension it demonstrates. State whether it is a
local application, an external-service integration, or a configuration example.
Link to the upstream project when applicable. Do not present optional example
functionality as a built-in capability of the default application.

### 2. Core capabilities / 核心能力

List the implemented, user-visible capabilities. Distinguish working features
from mocks or planned work. Avoid marketing claims and repeating the overview.

### 3. Architecture and boundaries / 架构边界

Describe the responsibilities and data flow of the framework, example code,
and external services. Name the public interface or protocol used and link to
the integration entry point. Explain who starts and stops any extra processes.

Example-specific logic and dependencies should stay in the example. Reuse public
extension points rather than private runtime imports or duplicated framework
logic. Any required core change must be justified as a generic capability in the
PR, with its own tests; it must not silently couple the default runtime to the example.
A small table or diagram is sufficient when it clarifies these boundaries.

### 4. Quick start / 快速开始

Provide a reproducible minimal path: prerequisites → dependency installation →
configuration → startup → access → one successful interaction → shutdown.
Specify the working directory, required services or credentials, supported
platforms, and expected result. Mark separate terminals and platform-specific
commands. Do not assume an unmentioned build, running service, or paid account.

### 5. Configuration and data / 配置与数据

Document required and optional settings, defaults, and precedence where relevant.
Keep these consistent with the code and `.env.example` or equivalent template.
Reference shared framework configuration instead of copying its entire reference.

State what data is sent externally, where local data is stored, whether existing
user configuration is reused or changed, and what persists across restarts.
Explain cleanup and credential handling, including remote retention limitations
where applicable. Do not imply that deleting local files also deletes remote data.

### 6. Validation and limitations / 验证与限制

Give runnable validation commands and an expected result or manual acceptance
procedure. Separate automated mocks, real-service tests, and unverified behavior.
State known platform, dependency, performance, and functional limitations.
For measurements, identify the tested version, conditions, and method.

Changed behavior needs proportionate regression coverage, including relevant
failure paths. Explain manual-only validation in the PR. CI success alone is not
proof of real-service behavior; do not claim tests that were not run.

### 7. Replacement and extension / 替换扩展

Explain how to replace the external service or customize the scenario through
the actual configuration, interface, or entry-point files. State which parts are
generic and which remain implementation-specific, and how to return to the
default setup. If replacement requires code, say so. Do not promise plug-and-play
compatibility or introduce an abstraction solely to fill this section.

### 8. Authors and acknowledgements / 作者与致谢

Credit the example's author or contributors with their actual contribution and
a public profile or PR link. Separately acknowledge upstream projects, libraries,
and assets with source links. Preserve original attribution when adapting work
and comply with applicable license and attribution requirements. Do not invent
authors or imply upstream endorsement.

## Review checklist

- [ ] Both READMEs contain the eight sections in order and agree on behavior.
- [ ] Capabilities and boundaries match the implementation; core changes are justified.
- [ ] Quick-start commands identify their working directories and prerequisites.
- [ ] Configuration, data flow, persistence, and cleanup are documented accurately.
- [ ] Validation is reproducible; mocks, live tests, and limitations are distinguished.
- [ ] Replacement guidance points to real interfaces or files.
- [ ] Authors, upstream sources, and applicable attribution are included.
- [ ] Links work; no credentials, private data, or generated runtime files are committed.

Record actual validation results and any deviations in the PR. This checklist is
a review aid, not a substitute for code review or applicable CI checks. See the
repository [contribution guide](../CONTRIBUTING.md) for general requirements.
