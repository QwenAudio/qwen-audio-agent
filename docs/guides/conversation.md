# Conversation & Attachments

Voice, text, and attachments share one conversation. The frontend handles chat and configured
tools, calling the backend when execution is needed. Not every utterance creates backend work.

## Voice and Text

- Allow microphone access in WebUI or the Desktop conversation panel to speak, or type and send text.
- Muting stops microphone input to the voice frontend. It does not cancel work or disable result announcements.
- **Sending** text or attachments prioritizes that manual input and interrupts the current frontend reply.
  Editing text or selecting/pasting attachments does not send them or actively interrupt playback.
- See [TUI](../getting-started/tui.md) for terminal commands and platform audio differences.

## Images and Files

In WebUI and the Desktop panel, use “＋”, drag and drop, or paste to add attachments, then send.
Each attachment is limited to 8 MB; a turn is limited to 12 MB in total. TUI has a separate
local-path input flow documented in its guide.

Ordinary attachments are different from realtime visual input:

| Input | Handling |
| --- | --- |
| Image / file attachment | The frontend gets a reference and summary, and can forward the original to a capable Backend Agent. |
| Realtime visual frames | Available when the client and voice Provider support continuous visual capture; currently used from WebUI. |

A voice frontend without direct image understanding can still accept image attachments for backend
processing. If no capable backend is configured, file-processing requests cannot be completed.
Send a short instruction such as “Describe this image” with the attachment to make the request clear.
Chat attachments do not automatically enter the [knowledge library](knowledge.md).

## History and New Conversations

The conversation area shows voice transcripts, assistant replies, and backend work cards. Starting a
new frontend conversation does not erase long-term memory and is not a way to cancel backend work.
Explicitly request cancellation and check the final status; see [Work & Permissions](tasks.md).

## Switching Clients

Each user can have one active client on a Gateway. Confirming takeover in a new client disconnects
the previous connection. Desktop's own Gateway and the CLI Gateway use separate runtimes by default;
see [Instances and Clients](../operations/gateway.md#instances-and-clients).
