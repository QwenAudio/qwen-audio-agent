# Frontend Knowledge and RAG

qwen-audio-agent keeps document knowledge in the voice frontend. It is not part
of a backend Agent workspace, ACP Session, or user work queue. The same saved
knowledge therefore remains available when the backend is `none` or changes.

The Realtime model sees one capability-gated `knowledge` tool:

- `index` saves text attachments only after an explicit user request.
- `search` retrieves relevant chunks from saved documents.
- `read` places one bounded document into the current context.
- `list` and `remove` manage the current owner's saved documents.

Uploads are never indexed automatically. Arbitrary local paths and remote URLs
are not read by indexing. Unsupported formats fail explicitly instead of being
guessed or sent to another service. Knowledge text is always treated as
untrusted factual material and cannot override system or user instructions.

## Pipeline and ports

```text
Explicitly selected attachment
    → DocumentExtractor
    → bounded text chunks
    → KnowledgeStore
    → KnowledgeRetrievalProvider
    → search results or bounded full context
```

The provider-neutral ports are:

- `DocumentExtractor`: advertises supported formats and extracts bounded text.
- `KnowledgeStore`: stores, lists, reads, and removes owner-scoped documents and
  reports health.
- `KnowledgeRetrievalProvider`: searches stored documents and returns bounded,
  normalized chunks.

The built-in extractor accepts UTF-8 plain text, Markdown, HTML, CSV, JSON, and
NDJSON. A source is limited to 5 MiB, extracted text to 500,000 characters, and
one document to 256 chunks during indexing. HTML scripts, styles, comments, and
tags are removed before storage.

The default retrieval provider is a small local lexical search implementation.
It requires no model call or external service and exists as a dependable
baseline. A stronger RAG service can implement `KnowledgeRetrievalProvider` and
be injected at the Gateway composition boundary without changing tools,
clients, or backend adapters.

`read` reconstructs overlapping chunks before returning the document. Full
context is limited to 48,000 characters and 48 KiB of UTF-8 text; larger
documents must use `search`. Search returns at most eight bounded chunks.

## System jobs, storage, and privacy

Indexing runs as a `knowledge_index` System Job. System Jobs use a pool
independent from user work and are not shown as task cards, assigned a user
`task_id`, announced, or delivered as task notifications. Writes for one owner
are serialized so the Desktop and CLI cannot silently overwrite one another.

The default store writes one hashed file per owner under:

```text
~/.config/qwaudio/knowledge/
```

The Desktop and CLI share this directory. Files are private to the current user,
bounded, atomically replaced, and protected by the shared cross-process
transaction lock. Only extracted text and source metadata are retained; the
original attachment is not copied into the knowledge store and its local path
is not persisted.

Set `QWEN_AUDIO_AGENT_KNOWLEDGE_DIR` to use a different directory. Custom stores,
extractors, and retrieval providers remain composition-time dependencies rather
than additions to the public Gateway or backend protocols.
