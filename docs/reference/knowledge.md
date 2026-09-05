# Knowledge Provider

qwen-audio-agent defines one small JavaScript Provider interface. It is not a
wire protocol and does not prescribe a vector database, embedding model,
parser, chunking policy, or index. An application can use the built-in local
library or connect an existing RAG or enterprise knowledge system with a thin
Adapter.

Without an injected Provider, the Gateway does not register the `knowledge`
tool and reports knowledge as unconfigured.

## Boundary

```text
Realtime Voice Agent
        │ knowledge(query)
        ▼
FrontendKnowledgeRuntime
  - capability gate, timeout, and cancellation
  - result bounds, citations, and untrusted-data notice
        │
        ▼
KnowledgeProvider
  - retrieve (used by the frontend model)
  - ingest / list / remove (optional client management)
        │
        ├─ built-in LocalKnowledgeProvider
        ├─ LlamaIndex / LangChain / Haystack Adapter
        ├─ MCP / HTTP Adapter
        └─ enterprise knowledge-service Adapter
```

The model can access only `retrieve()`. A separate
`KnowledgeLibraryService` exposes import, listing, and removal to clients.
Implementing management methods never turns them into model tools.

## Minimal interface

A Provider must implement `describe()` and `retrieve()`:

```js
import {
  KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
} from 'qwen-audio-agent/knowledge-provider'

const provider = {
  describe() {
    return {
      protocolVersion: KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
      key: 'company-knowledge',
      label: 'Company Knowledge',
      capabilities: {
        scores: true,
        citations: true,
        filters: true,
      },
    }
  },

  async retrieve(request, context) {
    return { results: [] }
  },

  // Optional: provide all three for document management.
  async ingest(request, context) {},
  async list(request, context) {},
  async remove(request, context) {},

  // Optional lifecycle methods.
  async health({ signal }) {
    return { status: 'ready' }
  },
  async close() {},
}
```

The version constant is only a fast compatibility check for the npm code
interface; it does not define a separate transport protocol. HTTP, MCP, or SDK
details remain inside the Adapter.

A retrieval-only integration can omit `ingest/list/remove`. The Gateway opens
the library-management surface only when all three are present.

## Retrieval

Model-controlled input and trusted Gateway context stay separate:

```js
request = {
  query: 'What is the release approval policy?',
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

A Provider returns source excerpts that the frontend can use directly, not an
instruction to ask the backend to read a file:

```js
{
  results: [{
    id: 'chunk-42',
    content: 'A release requires approval from two reviewers.',
    score: 0.91,
    source: {
      id: 'release-handbook',
      title: 'Release Handbook',
      uri: 'https://docs.example.com/releases',
      mimeType: 'text/markdown',
      locator: 'section=approvals',
    },
    metadata: { department: 'engineering' },
  }],
}
```

Only `id` and `content` are required. The Gateway bounds and deduplicates
results, normalizes public citations, and marks knowledge as untrusted data.
The Provider must never accept owner identity from model arguments.

## Ingestion and management

A complete Provider uses the same small set of semantics:

```js
await provider.ingest({
  source: {
    type: 'file',
    path: '/Users/me/manual.pdf',
    name: 'manual.pdf',
  },
}, { ownerId, taskId, signal, onEvent })

await provider.list({}, { ownerId })
await provider.remove({ documentId: 'doc-42' }, { ownerId })
```

`ingest()` returns a Promise. The Gateway uses its own TaskManager for queueing,
cancellation, and status, so a Provider does not need another ingestion-job
protocol. If a remote service indexes asynchronously, its Adapter can wait or
poll inside `ingest()` and stop when `signal` is aborted.

## Built-in basic implementation

The repository internally includes `LocalKnowledgeProvider`, enabled by
`QWEN_AUDIO_DOMAIN_LIBRARY=on`. It is a useful basic implementation, not a full
RAG stack:

- Markdown, TXT, and similar text files are copied directly into the local library;
- PDF, Word, PPT, and other rich documents are converted to Markdown by the one `AgentDocumentConverter`;
- simple keyword retrieval scans Markdown headings and bounded text chunks;
- `retrieve()` returns matching source excerpts directly;
- import, list, and remove are supported without a vector database or embeddings.

Rich-document conversion shares the configured backend Agent process, model,
authentication, and tools, but opens a fresh isolated execution Session for
every document. It does not use the coordinator or delegated Sessions, inherit
voice-task context, or enter the automatic announcement queue. Whether
conversion succeeds or fails, the Session is closed or cancelled and its local
record is released, so the Gateway does not accumulate active Sessions across
ingestions. The Agent is an internal converter for this basic Provider.

Without a backend Agent or isolated execution, text files still work and rich
documents report that no converter is available.

## Switching knowledge systems

Inject a Provider at the application composition root:

```js
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'

const gateway = createGatewayApplication({ knowledgeProvider: provider })
```

An Adapter only translates fields and calls:

| System | Adapter responsibility |
| --- | --- |
| LangChain | Call a Retriever and map Documents to results. |
| LlamaIndex | Call a Retriever and map Nodes, scores, and metadata. |
| Haystack | Run a Retriever and, when management is exposed, its indexing pipeline. |
| RAGFlow / enterprise service | Map query, upload, document-list, and delete APIs. |
| MCP / HTTP | Call the corresponding tool or endpoint and map its objects. |

Vendor clients, remote job IDs, vector-store collection IDs, and raw responses
stay inside the Adapter and never cross into the Gateway, Realtime, or clients.

For the matching concepts in established frameworks, see the
[LlamaIndex Ingestion Pipeline](https://developers.llamaindex.ai/python/framework/module_guides/loading/ingestion_pipeline/)
and [Haystack DocumentWriter](https://docs.haystack.deepset.ai/docs/documentwriter).
