# LightRAG Knowledge Base

qwen-audio-agent can use an independently operated
[LightRAG](https://github.com/HKUDS/LightRAG) instance as frontend knowledge. LightRAG owns
document parsing, embeddings, indexing, and retrieval; the Gateway calls it only through the
`KnowledgeProvider` boundary.

## When to use it

- You want richer semantic and graph retrieval than the built-in keyword library.
- You already use LightRAG and want the voice frontend to reuse its documents and model setup.
- You want the knowledge system to evolve or be replaced independently of Realtime and clients.

## Prepare LightRAG

LightRAG requires an independently configured LLM and embedding model. Either can run locally or
through an OpenAI-compatible service. Install the Server with `uv`:

```bash
uv tool install "lightrag-hku[api]"
```

Create `.env` in the LightRAG working directory with this general shape:

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

LIGHTRAG_API_KEY=your_lightrag_api_key
```

The embedding dimension must match the model. Follow the
[official LightRAG documentation](https://github.com/HKUDS/LightRAG/blob/main/docs/LightRAG-API-Server.md)
for the complete configuration. Start a localhost-only service:

```bash
lightrag-server --host 127.0.0.1 --port 9621
```

## Run the integration example

From a qwen-audio-agent source checkout:

```bash
cp examples/lightrag/.env.example examples/lightrag/.env.local
```

Set the voice frontend and LightRAG connection values:

```dotenv
DASHSCOPE_API_KEY=your_dashscope_api_key
LIGHTRAG_URL=http://127.0.0.1:9621
LIGHTRAG_API_KEY=your_lightrag_api_key
LIGHTRAG_WORKSPACE=
LIGHTRAG_QUERY_MODE=mix
```

Start the example:

```bash
node --env-file=examples/lightrag/.env.local examples/lightrag/gateway.mjs
```

Open `http://127.0.0.1:3101`, import a file from the Knowledge Library panel, wait for indexing,
then query it by voice or text. This isolated example uses frontend-only mode and does not start
a backend Agent.

`DASHSCOPE_API_KEY` belongs only to the voice frontend. LightRAG keeps its LLM and embedding
configuration in its own process. qwen-audio-agent does not install, start, or modify LightRAG.

## Data and task boundaries

- The Gateway obtains raw chunks from `/query/data`; the voice frontend generates the answer.
- LightRAG `track_id` values, graph objects, and HTTP responses do not reach the client or model.
- Upload and deletion are asynchronous inside LightRAG, but the Gateway reports success only
  after real completion.
- Cancelling a Gateway ingestion task stops waiting without invoking a global pipeline cancel
  that could affect other documents.
- Users remain responsible for LightRAG documents, indexes, credentials, and workspace storage.

See [`examples/lightrag`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/lightrag)
for the full code and configuration reference.

## Authors and acknowledgements

- Thanks to [the LightRAG project and its contributors](https://github.com/HKUDS/LightRAG) for
  open-sourcing the document processing, knowledge graph, and retrieval capabilities.
- [Li Xu](https://github.com/x-lixu) designed the replaceable `KnowledgeProvider` boundary and
  implemented this integration example.
