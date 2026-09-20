# Long-Term Memory

Long-term memory helps the assistant remember you across conversations. The default implementation uses Markdown files without a separate database.

## Remember, Inspect, and Delete

Try:

- “Remember that I now live in Hangzhou.”
- “What have you remembered about me?”
- “Change my home city to Suzhou.”
- “Forget that address.”

Preferences are stored in `<data-dir>/USER.md`; facts and decisions in `<data-dir>/MEMORY.md`. A new conversation does not clear these files. Conversation edits apply immediately; direct file edits apply in the next voice session.

Lists and reference documents have separate features: [Lists and Reminders](../guides/notes-reminders.md), [Knowledge Library](../guides/knowledge.md).

## Automatic Extraction

After a session ends, the default Markdown provider can use a text model to save missing long-term information: explicit interaction preferences in `USER.md` and stable facts or decisions in `MEMORY.md`. It cannot change `ASSISTANT.md`.

The default is DashScope `qwen-flash` using `DASHSCOPE_API_KEY`. Without an available key, automatic extraction is disabled; explicit memory-tool requests remain available. Disable extraction or configure another OpenAI-compatible text service:

```dotenv
QWEN_AUDIO_MEMORY_AUTO=off
```

| Setting | Purpose |
| --- | --- |
| `QWEN_AUDIO_MEMORY_MODEL` | Text model for extraction |
| `QWEN_AUDIO_MEMORY_BASE_URL` | OpenAI-compatible service endpoint |
| `QWEN_AUDIO_MEMORY_API_KEY` | Credentials for that service |

Extraction incurs additional model usage. It learns only from new conversation, not replayed history. After a successful memory edit through a tool or client, stale learning results cannot restore the old content. Extraction can still make mistakes; review and correct memories periodically.

## Recall Earlier Conversations

Disabled by default. Enable topic summaries after sessions; the default retention is 90 days:

```dotenv
QWEN_AUDIO_SESSION_DIGEST=on
```

Ask “What was the project we discussed a few days ago?” Summaries are retrieved on demand; they are not recordings or verbatim transcripts.

A summary may record earlier work, but does not freeze its status. Available status comes from the current task ledger. Once a record expires, recall can describe what was discussed or requested, not verify current progress.

## VoiceMem and Custom Providers

Optional [VoiceMem](../scenarios/voicemem.md) takes over memory, retrieval, and session learning. Install it separately; the core npm package does not include it:

```dotenv
QWEN_AUDIO_MEMORY_PROVIDER=voicemem
VOICEMEM_PYTHON=/absolute/path/to/python
VOICEMEM_SIDECAR=/absolute/path/to/voicemem-sidecar.py
VOICEMEM_INPUT_MODE=text
```

`text` reuses transcription; `audio` sends turn-scoped user audio to VoiceMem. Switching providers does not migrate or delete the other provider's data. Back up first.

See [Memory Provider](memory-provider.md) for developer interfaces.

## Privacy and Diagnostics

Relevant memories become voice-model context. Automatic extraction also sends conversation to the configured text service. Do not store passwords, API keys, verification codes, or tokens.

`<state-dir>/memory-audit.jsonl` contains learning diagnostics. Review logs before sharing. See [Local Logs](../configuration/advanced.md#local-logs) for standard log locations and rotation.
