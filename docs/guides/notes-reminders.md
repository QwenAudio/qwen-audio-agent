# Lists and Reminders

Lists store items; reminders notify you at a scheduled time. Neither is a background task by default, and neither automatically becomes long-term memory.

## Manage Lists

Name the list and describe the change:

- “Create a shopping list with milk and eggs.”
- “Show my shopping list.”
- “Remove eggs from the shopping list.”
- “Clear the shopping list.” — Remove its items, keeping the list.
- “Delete the shopping list.” — Remove the entire list.

The default store is `<data-dir>/frontend-notes.json` and survives restarts. No backend Agent is required. To disable the tool:

```dotenv
QWEN_AUDIO_NOTES_TOOL_ENABLED=false
```

## Set Reminders

Try “Remind me to drink water in ten minutes” or “Remind me about the meeting every weekday at nine.”

Supported schedules are one-time, daily, weekly, and weekdays. Check the confirmed time and content. Clarify the date, time zone, or exact time when needed.

- “Remind me to check the report” schedules a spoken reminder.
- “Check the weather tomorrow morning and tell me” schedules execution and requires a backend Agent.
- Ask to list or cancel reminders. For a repeating reminder, specify whether to cancel the whole series.

To disable the reminder tool:

```dotenv
QWEN_AUDIO_SCHEDULE_TOOL_ENABLED=false
```

## Operating Conditions

The Gateway that created a reminder owns its schedule. For timely delivery, keep that Gateway running, prevent the host from sleeping, and keep a playback-capable client connected.

Reminder records persist. After restart, the Gateway processes overdue reminders still awaiting execution. This is not an OS alarm or mobile push service and cannot guarantee on-time offline notifications. A hidden Desktop client is not forcibly awakened to speak.

These tools require a voice frontend with tool-call support; the current MiniCPM-o adapter does not provide it. See [Run the Gateway](../operations/gateway.md) for background service setup.
