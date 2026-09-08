# Knowledge Library

The library lets the assistant find evidence in your documents. The built-in implementation uses
lightweight local keyword retrieval and requires no separate vector database or Embedding model.
For richer semantic and graph retrieval, see the [LightRAG example](../scenarios/lightrag.md).

## 1. Enable the Library

Set this in the `config.env` used by the Gateway:

```dotenv
QWEN_AUDIO_DOMAIN_LIBRARY=on
```

[Restart for your run mode](../operations/gateway.md#applying-configuration-changes).
If you explicitly disabled `QWEN_AUDIO_KNOWLEDGE_TOOL_ENABLED`, restore it to `true`;
otherwise document management can work while the frontend has no retrieval tool.
The voice Provider must support tool calls.

## 2. Import Documents

1. Open **WebUI** connected to that Gateway and click “Knowledge Library” at the top.
2. Paste an **absolute file path on the Gateway host**, such as `/Users/me/Documents/handbook.md`.
3. Click “Add to library” and wait for import completion. Ask questions once the document appears in the list.

This is not a file uploader. A path on a remote phone does not refer to a file on the computer;
place the document on the Gateway host first. The Desktop orb and conversation panel do not
currently expose a library-management button.

| File type | Built-in handling |
| --- | --- |
| Markdown, TXT, and similar text | Imported directly; no Backend Agent required. |
| PDF, Word, PPT, and other complex documents | Converted to Markdown by a configured backend supporting isolated execution; conversion depends on its tools. |

Complex documents use an isolated execution session, not the everyday coordinator conversation,
and do not inherit voice-chat context. Import errors appear in the panel. If no converter is available,
convert the document to Markdown or TXT yourself before importing it.

## 3. Query and Remove

Ask, for example: “Search the library: what does the handbook say about the release process?”
Built-in retrieval returns source excerpts matched by headings and body keywords; the frontend
composes the answer. It is not a full semantic retrieval system. Try the document's own terms or
a more precise question if results are weak.

“Remove” deletes the library copy and its searchable content, not the original source file.
Chat attachments are not automatically imported. Source-file changes are not automatically
synchronized either; reimport updated content.

## Data and Other Knowledge Systems

Built-in library data is stored on the Gateway host. With a cloud voice model, retrieved excerpts
are sent to that model as answer context. Complex-document conversion also uses the backend's
configured models and tools. Check that these services are appropriate for the documents.

To reuse another knowledge system, see [LightRAG](../scenarios/lightrag.md).
For adapter development, see the [Knowledge Provider interface](../reference/knowledge.md).
