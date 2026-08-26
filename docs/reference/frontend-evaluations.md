# Frontend Runtime Evaluations

The deterministic frontend evaluation suite protects the runtime boundaries
that qwen-audio-agent can guarantee independently from a Realtime model or
provider:

| Dimension | Invariant |
| --- | --- |
| Routing | Search, URL Fetch, optional Knowledge retrieval, backend Task, and client control remain separate capability-gated tools. |
| Citation | Sources receive stable per-turn IDs, duplicate URLs keep one identity, unsafe URLs are dropped, and final citations are consumed once. |
| Interruption | Audio and transcripts arriving after a user interruption are suppressed, while the interruption event is projected once. |
| Duplicate speech | Duplicate completion signals coalesce before presentation, and repeated acknowledgements do not create another presentation for the same Task. |
| Prompt injection | Search and Knowledge content stays untrusted data, carries an explicit notice, and cannot change the registered tool surface. |

Run the suite with:

```bash
npm run eval:frontend
```

Use `npm run eval:frontend -- --json` for a machine-readable report. The same
evaluations also run from the server test suite and therefore from
`release:check` and CI.

The suite drives production Runtime components; it does not contain a second
implementation of routing, presentation, or citation behavior. It makes no
external request and does not call a language model, so results are fast and
repeatable on every supported operating system.

These checks do not claim to measure provider-specific semantic quality, such
as how often one model selects the ideal tool for a natural-language request.
Such live-model evaluations may reuse the same dimensions, but stay outside the
deterministic release gate because they require credentials, cost, and
statistical thresholds.
