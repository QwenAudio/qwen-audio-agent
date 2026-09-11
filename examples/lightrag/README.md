# Qwen Audio Agent LightRAG Integration Example

English | [中文](README_ZH.md)

This example connects an independently deployed
[LightRAG](https://github.com/HKUDS/LightRAG) instance to qwen-audio-agent. LightRAG owns
document parsing, chunking, embeddings, indexing, and retrieval. The Gateway only consumes it
through the generic `KnowledgeProvider` boundary; it does not install, start, or reconfigure
LightRAG.

## Core features

- **Replaceable knowledge base:** the generic runtime depends only on the versioned
  `KnowledgeProvider` contract; all LightRAG-specific code stays in this example.
- **Raw-context retrieval:** `/query/data` supplies source chunks while the voice frontend
  remains responsible for the final answer.
- **Complete library management:** file upload, asynchronous indexing, paginated listing,
  and asynchronous deletion are supported.
- **Independent model configuration:** LightRAG owns its LLM, embedding model, indexes,
  and storage without implicit configuration sharing with the voice frontend.
- **Provider object isolation:** graph objects, remote `track_id` values, and raw HTTP
  responses never cross the provider boundary.

## Architecture

| Component | Responsibility |
|---|---|
| qwen-audio-agent Gateway | Realtime voice conversation, knowledge tools, and ingestion task lifecycle. |
| [`LightRagKnowledgeProvider`](lightrag-provider.mjs) | Maps LightRAG APIs to the generic `KnowledgeProvider`. |
| [`LightRagClient`](lightrag-client.mjs) | LightRAG URL, authentication, workspace, timeouts, and HTTP errors. |
| User-managed LightRAG Server | Document parsing, chunking, embeddings, graph, indexing, and retrieval. |

The provider calls LightRAG `/query/data` for raw retrieval chunks, leaving final answer
generation to the voice frontend. Graph objects, remote `track_id` values, and raw HTTP
responses never cross the provider boundary.

## Quick start

Use the Node.js version required by the repository and install `uv` first. From the
qwen-audio-agent repository root:

```bash
npm ci
```

### Install and configure LightRAG

Install LightRAG independently with `uv`:

```bash
uv tool install "lightrag-hku[api]"
mkdir -p ~/lightrag-runtime
cd ~/lightrag-runtime
```

LightRAG requires both an LLM and an embedding model. They may run through local Ollama or an
OpenAI-compatible service; the user owns the model, dimensions, and endpoint choices. The
following is only the minimal shape of the `.env` file in the current directory:

```dotenv
LLM_BINDING=openai
LLM_BINDING_HOST=https://your-openai-compatible-service.example/v1
LLM_BINDING_API_KEY=your_llm_key
LLM_MODEL=your_llm_model

EMBEDDING_BINDING=openai
EMBEDDING_BINDING_HOST=https://your-openai-compatible-service.example/v1
EMBEDDING_BINDING_API_KEY=your_embedding_key
EMBEDDING_MODEL=your_embedding_model
EMBEDDING_DIM=1024

# Recommended even for a local API
LIGHTRAG_API_KEY=your_lightrag_api_key
```

`EMBEDDING_DIM` must match the selected embedding model. Do not change the model or dimension
after indexing data without clearing and rebuilding the LightRAG index as documented upstream.

Start a server bound only to localhost:

```bash
cd ~/lightrag-runtime
lightrag-server --host 127.0.0.1 --port 9621
```

Open `http://127.0.0.1:9621/webui` to verify it. See the
[official LightRAG Server documentation](https://github.com/HKUDS/LightRAG/blob/main/docs/LightRAG-API-Server.md)
for complete model, parser, and storage configuration.

### Start the example Gateway

From the qwen-audio-agent repository root:

```bash
cp examples/lightrag/.env.example examples/lightrag/.env.local
```

Edit `.env.local`:

```dotenv
DASHSCOPE_API_KEY=your_dashscope_api_key
AGENT_PROTOCOL=none

LIGHTRAG_URL=http://127.0.0.1:9621
LIGHTRAG_API_KEY=your_lightrag_api_key
LIGHTRAG_WORKSPACE=
LIGHTRAG_QUERY_MODE=mix
```

`DASHSCOPE_API_KEY` belongs only to the qwen-audio-agent voice frontend. LightRAG uses the model
configuration of its own process. The two processes do not automatically share configuration,
even when they call the same model provider.

Start the example:

```bash
node --env-file=examples/lightrag/.env.local examples/lightrag/gateway.mjs
```

Open `http://127.0.0.1:3101`. This isolated example uses frontend-only mode to test the
knowledge provider without starting a backend Agent.

## Try it

1. Open **Knowledge Library** in the WebUI.
2. Paste an absolute path to a local file and import it.
3. Wait for LightRAG to finish parsing and indexing.
4. Ask: “According to my knowledge library, summarize the release approval rules.”

Upload is asynchronous: LightRAG keeps indexing after returning a `track_id`. The provider
polls internally until `PROCESSED` or `FAILED`, so the Gateway updates its ingestion task only
after a real terminal state. Deletion likewise waits for remote completion instead of treating
`deletion_started` as “deleted.”

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LIGHTRAG_URL` | `http://127.0.0.1:9621` | LightRAG Server endpoint |
| `LIGHTRAG_API_KEY` | empty | LightRAG access key sent as `X-API-Key` |
| `LIGHTRAG_WORKSPACE` | empty | Optional workspace selector sent as `LIGHTRAG-WORKSPACE`; leave empty unless the operator provisioned one |
| `LIGHTRAG_QUERY_MODE` | `mix` | `local`, `global`, `hybrid`, `naive`, or `mix` |
| `LIGHTRAG_RETRIEVAL_TIMEOUT_MS` | `60000` | Maximum time the Gateway waits for retrieval |
| `LIGHTRAG_REQUEST_TIMEOUT_MS` | `30000` | Timeout for one HTTP request |
| `LIGHTRAG_INGESTION_TIMEOUT_MS` | `900000` | Maximum wait for indexing |
| `LIGHTRAG_DELETION_TIMEOUT_MS` | `120000` | Maximum wait for deletion |
| `LIGHTRAG_POLL_INTERVAL_MS` | `1000` | Remote job polling interval |

Cancelling a Gateway ingestion task stops the provider's local wait. It deliberately does not
call LightRAG's global `cancel_pipeline`, which could cancel unrelated documents in the same
instance.

Leave `LIGHTRAG_WORKSPACE` empty unless a LightRAG operator has provisioned a workspace for this
key. Today LightRAG reads the `LIGHTRAG-WORKSPACE` header only on its status route; the retrieval
and document endpoints ignore it, so a value here does not isolate data — everything lands in the
server's configured workspace. Once server-side multi-workspace support lands, a selector without
a catalog record whose member table includes this key is rejected rather than silently falling
back, so an unset selector is the correct configuration before and after that change.

## Replace and extend

| Goal | Change |
|---|---|
| Use an existing LightRAG service | Set `LIGHTRAG_URL` and `LIGHTRAG_API_KEY`. |
| Tune retrieval | Set `LIGHTRAG_QUERY_MODE` and the retrieval timeout. |
| Embed in another host | Create the provider and inject it through `knowledgeProvider` in `createGatewayApplication`. |
| Replace LightRAG | Implement the same versioned `KnowledgeProvider` contract. |

To integrate another knowledge system, replace only the provider. Realtime tools, Gateway
tasks, and clients require no vendor-specific code. See
[Knowledge Provider](../../docs/reference/knowledge.md) for the complete contract.

## Authors and acknowledgements

- [The LightRAG project and its contributors](https://github.com/HKUDS/LightRAG): created and
  open-sourced LightRAG, which provides the document processing, knowledge graph, and retrieval
  capabilities used by this example.
- [Li Xu](https://github.com/x-lixu): designed the replaceable `KnowledgeProvider` boundary and
  implemented the LightRAG integration example.
