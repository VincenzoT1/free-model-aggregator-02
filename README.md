# High-Quality Resilient Free-Model Aggregator

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/VincenzoT1/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/VincenzoT1/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

An intelligent AI model aggregation and proxy server compliant with both OpenAI (`POST /v1/chat/completions`) and Anthropic (`POST /v1/messages`) APIs, routing to OpenRouter's free models with guaranteed optimal quality rating and resilient failover for [make.fun bounty](https://make.fun/bounty/free-model-aggregator-02).

## Key Features

1. **Optimal Rating-Driven Routing (60% Quality Metric)**
   - Ranks all available free models by their published benchmark ratings (`rating_milli`) in descending order.
   - Accurately inspects and matches specific request capabilities (JSON mode, tools execution, vision, minimum context size).
   - Selects the absolute highest-rated model for each prompt's constraints.

2. **Zero-Downtime Failover & Cooldown Tracking (10% Failover Metric)**
   - Automatically detects 4xx/5xx or rate limit responses from upstream providers.
   - Places failing models into a temporary cooldown state to prevent repetitive errors.
   - Retries transparently on the next-best model fulfilling the prompt requirements.
   - Accurately tracks upstream refusals and emits the `x-makefun-upstream-failures` audit header.

3. **Complete Wire Protocol Compatibility**
   - Full support for standard JSON and Server-Sent Events (SSE) streaming on both OpenAI and Anthropic interfaces.
   - Preserves exact model identifiers on completions and chunk deltas.
   - Enforces correct token usage, stop reasons, and tool response mappings.

4. **Deterministic Catalog Synchronization (5% Catalog Metric)**
   - Synchronizes `--list` catalog output with `GET /v1/models` across both OpenAI and Anthropic authorization schemes.
