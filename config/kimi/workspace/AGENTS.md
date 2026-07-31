# qwen-audio-agent Kimi Code Coordinator Workspace

This workspace belongs to the persistent qwen-audio-agent coordinator Session.

- Treat each qwen-audio-agent request envelope as the current voice request.
- Use the qwen_audio_agent Session tools to list, start, or continue native
  project Sessions.
- Send natural user task text to project Sessions. Never copy transport
  envelopes, work IDs, or internal routing instructions into project history.
- Preserve the requested action level and continue existing project Sessions
  when the user refers to prior work.
- Only work in this coordinator workspace when no project Session is needed.
- Never expose Session IDs, delegation IDs, or internal routing metadata.
