# Frontend Knowledge Foundation

qwen-audio-agent keeps document knowledge in the voice frontend. It is not part of a backend
Agent workspace, ACP Session, or user work queue. This boundary lets the frontend answer from the
same knowledge even when the selected backend is `none` or changes later.

This release establishes the storage and indexing foundation only. It does not automatically
index uploads and does not expose a document-retrieval tool to the Realtime model yet. Retrieval,
context selection, and RAG tools build on this layer in the next Roadmap stage.

## Pipeline

```text
Document source
    → DocumentExtractor
    → bounded text chunks
    → KnowledgeStore
```

Indexing runs as a `knowledge_index` System Job. System Jobs use a pool independent from user
work and are not shown as task cards, assigned a `job_id`, announced, or delivered as task
notifications. Writes for one owner are serialized so the Desktop and CLI cannot silently
overwrite one another.

The two provider-neutral ports are:

- `DocumentExtractor`: advertises supported formats and extracts bounded text.
- `KnowledgeStore`: stores, lists, reads, and removes owner-scoped documents and reports health.

The built-in extractor accepts UTF-8 plain text, Markdown, HTML, CSV, JSON, and NDJSON. A source
is limited to 5 MiB, extracted text to 500,000 characters, and one document to 256 chunks during
indexing. HTML scripts, styles, comments, and tags are removed before storage. Unsupported binary
formats fail explicitly; they are not guessed or sent to another service.

## Local storage and privacy

The default store writes one hashed file per owner under:

```text
~/.config/qwaudio/knowledge/
```

The Desktop and CLI share this asset directory. Files are private to the current user, bounded,
atomically replaced, and protected by the same cross-process transaction lock used by other
shared assets. Only extracted text and source metadata are retained; the original binary is not
copied into the knowledge store.

Set `QWEN_AUDIO_AGENT_KNOWLEDGE_DIR` to use a different directory. A custom store or extractor can
also be injected at the Gateway composition boundary without changing the frontend or backend
protocols.
