# Knowledge Retrieval Provider

qwen-audio-agent defines a small retrieval boundary instead of shipping a RAG
stack. It does not choose a vector database, embedding model, document parser,
chunker, index, or ingestion workflow. Applications can connect the knowledge
system they already operate.

Knowledge is optional. With no provider injected, the Gateway creates no
knowledge directory, registers no `knowledge` tool, and reports the capability
as unconfigured. CLI, TUI, WebUI, and Desktop therefore share the same behavior.

## Boundary

```text
Realtime Voice Agent
        │ knowledge(query)
        ▼
FrontendKnowledgeRuntime
  - capability gating
  - timeout and cancellation
  - result bounds and normalization
  - citations and untrusted-data notice
        │ provider-neutral request
        ▼
KnowledgeRetrievalProvider
        │
        ├─ LangChain / LlamaIndex adapter
        ├─ Haystack adapter
        ├─ OpenAI File Search adapter
        ├─ MCP or HTTP adapter
        └─ private enterprise knowledge service
```

The core owns retrieval safety. The provider owns connection credentials,
tenant mapping, document management, indexing, ranking, and vendor APIs.

## Provider contract

Import the public contract from:

```js
import {
  KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
} from 'qwen-audio-agent/knowledge-provider'
```

A provider requires only `describe()` and `retrieve()`:

```js
const provider = {
  describe() {
    return {
      protocolVersion: KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
      key: 'company-search',
      label: 'Company Knowledge',
      capabilities: {
        filters: true,
        scores: true,
        citations: true,
      },
    }
  },

  async retrieve(request, context) {
    return { results: [] }
  },

  // Optional lifecycle methods.
  async health({ signal }) {
    return { status: 'ready' }
  },

  async close() {},
}
```

`key` uses lowercase letters, digits, and hyphens. Protocol version `1` is
required so incompatible providers fail during composition rather than during a
voice turn. Capability values are descriptive booleans; they do not change the
core request or response schema.

`health()` is optional and may return `ready`, `unconfigured`, `degraded`, or
`unavailable`. If omitted, the provider is treated as ready. `close()` is also
optional and is called once when the Gateway closes.

## Request and trusted context

The two arguments are deliberately separate:

```js
request = {
  query: 'What is the release policy?',
  topK: 5,
  knowledgeBaseIds: ['engineering'],
  filters: {},
}

context = {
  ownerId,
  sessionId,
  turnId,
  traceId,
  signal,
}
```

The model can propose the query, result count, and a previously disclosed
knowledge-base ID. The Gateway injects owner, session, turn, trace, timeout, and
cancellation context. A provider must never accept tenant identity from model
arguments.

`topK` is bounded to `1..8`. `knowledgeBaseIds` is bounded to eight values.
Programmatic hosts may supply provider-specific filters; the default Realtime
tool does not expose arbitrary filters to the model.

## Response

Return an array or `{ results: [...] }`:

```js
{
  results: [{
    id: 'chunk-42',
    content: 'Releases require two reviewers.',
    score: 0.91,
    source: {
      id: 'release-handbook',
      title: 'Release handbook',
      uri: 'https://docs.example.com/releases',
      mimeType: 'text/markdown',
      locator: 'section=approvals',
    },
    metadata: {
      department: 'engineering',
    },
  }],
}
```

Only `id` and `content` are required. The Gateway truncates content, rejects
empty results, deduplicates IDs, bounds primitive metadata, and normalizes the
remaining fields. A public HTTP(S) source URI becomes a stable per-turn
citation. Private or credential-bearing URIs are dropped; providers should use
bounded `source.id` and `source.locator` fields for non-public locations.

Knowledge content is always projected as untrusted data. It can supply facts,
but cannot add tools or override system and user instructions.

## Composition

Inject the provider at the application composition root:

```js
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'

const gateway = createGatewayApplication({
  knowledgeProvider: provider,
})
```

This is the only required integration point. The runtime advertises the
`knowledge` capability, registers the retrieval tool, and closes the provider
with the Gateway. Provider-specific configuration stays in the embedding
application or adapter.

## Adapter guidance

Mainstream systems map naturally to this boundary:

| System | Adapter mapping |
| --- | --- |
| LangChain | Invoke a Retriever with `request.query`; map returned Documents to results. |
| LlamaIndex | Call a Retriever; map retrieved nodes, scores, and node metadata. |
| Haystack | Run a Retriever component; map scored Documents and metadata filters. |
| OpenAI File Search | Map query, vector-store scope, result count, file citations, and content. |
| MCP | Call one retrieval tool and translate its structured output. |
| HTTP | POST the canonical request and translate the service response. |

References: [LangChain retrievers](https://docs.langchain.com/oss/python/integrations/retrievers),
[LlamaIndex retrievers](https://developers.llamaindex.ai/python/framework/module_guides/querying/retriever/),
[Haystack retrievers](https://docs.haystack.deepset.ai/docs/retrievers), and
[OpenAI File Search](https://developers.openai.com/api/docs/guides/tools-file-search).

Adapters should translate vendor fields at their boundary. Vendor clients and
response objects must not leak into Gateway, voice, or client code.

## Document management is a separate extension

Ingestion, listing, reading full documents, updating, and deleting are not part
of protocol v1. They differ substantially across services and often require
stronger authorization than retrieval. An application may expose a separate
management UI or define its own `KnowledgeManagementProvider`; it should not
extend the model-visible retrieval tool with vendor-specific actions.

This separation keeps retrieval lightweight and lets each implementation use
its native administration and configuration flow.
