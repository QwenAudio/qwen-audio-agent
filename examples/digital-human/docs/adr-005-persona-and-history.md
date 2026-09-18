# ADR-005: Persona, Avatar Session, and Conversation History

- Status: Proposed
- Scope: Digital human example and desktop multi-persona clients
- Depends on: ADR-001 through ADR-004

## Context

The desktop product may expose three skins with different personas. A skin switch
must replace the visual Renderer state immediately, while conversation-history
behavior is a product decision: personas may share one conversation, or each may
resume only its own history.

Using `ownerId` alone to represent user identity, skin, persona, and history
partitioning couples unrelated concerns and makes migrations or analytics unsafe.

## Decision

Represent identity and lifecycle with separate fields:

| Field | Owner | Purpose |
| --- | --- | --- |
| `ownerId` | Application identity layer | Stable authenticated user or tenant identity |
| `conversationSessionId` | Gateway/client | One restorable conversation-history stream |
| `personaId` | Product configuration | Selected behavior, voice, and avatar configuration |
| `avatarSessionId` | Renderer | Ephemeral loaded avatar instance |
| `responseId` | Gateway | One assistant response across text, audio, and avatar media |
| `speechId` | Renderer protocol | One ordered speech input within an avatar session |

`ownerId` must not be changed merely to switch a skin. It remains stable for the
same authenticated user.

## History Policies

The client supports an explicit history policy.

### Shared Conversation

All personas use one `conversationSessionId`. Switching `personaId` changes
future behavior and visual presentation while preserving the same history.

```text
ownerId U1
conversationSessionId C1
persona A -> avatarSession A1
persona B -> avatarSession B1
```

This is appropriate when skins are visual variants of the same assistant.

### Isolated Conversation

The client stores one `conversationSessionId` per `personaId` and restores the
selected pair on switch.

```text
ownerId U1
persona A -> conversationSession CA -> avatarSession A1
persona B -> conversationSession CB -> avatarSession B1
persona C -> conversationSession CC -> avatarSession C1
```

This is appropriate when each skin represents a distinct character or role.

The recommended default for genuinely different personas is isolated history.

## Client Mapping

The client persists a mapping scoped by the authenticated user and deployment:

```json
{
  "historyPolicy": "isolated",
  "activePersonaId": "persona-a",
  "conversationSessions": {
    "persona-a": "conversation-session-a",
    "persona-b": "conversation-session-b",
    "persona-c": "conversation-session-c"
  }
}
```

The Gateway continues to receive the normal `ownerId` and selected
`conversationSessionId`. The Renderer receives `personaId`, `avatarSessionId`,
`responseId`, and `speechId`, but does not need `ownerId` or conversation history.

## Switch Transaction

Persona switching is treated as one serialized client transaction:

1. Block creation of a new response controller.
2. Cancel the active response and settle its playback receipt.
3. Close and detach the old `avatarSessionId` and media tracks.
4. Select or create the target persona's `conversationSessionId` according to
   `historyPolicy`.
5. Restore Gateway history for that conversation session.
6. Create the target persona's Renderer session.
7. Resume input only after Gateway and Renderer readiness are resolved.

Gateway restoration and Renderer warmup may run concurrently after step 4. User
input remains blocked until the client can assign it unambiguously to one persona
and one conversation session.

## Configuration Resolution

`personaId` resolves through an application-owned allowlisted manifest:

```json
{
  "persona-a": {
    "displayName": "Persona A",
    "voiceId": "voice-a",
    "rendererProfile": "flashhead-lite-a",
    "conversationProfile": "assistant-a"
  }
}
```

The client sends identifiers, not arbitrary prompts, checkpoint paths, reference
image paths, or shell/configuration fragments.

## Failure Semantics

- Gateway restore failure: keep the persona switch incomplete and do not attach
  the wrong conversation history.
- Renderer creation failure: preserve the chosen conversation and enter explicit
  audio-only mode for that persona.
- Switch interruption: finish cleanup of the old generation before applying the
  latest requested persona; intermediate queued switches may be collapsed.
- Application restart: recover the mapping, but always create a new ephemeral
  `avatarSessionId`.

## Consequences

- Visual skins can change without manufacturing user identities.
- History sharing or isolation is visible, configurable, and testable.
- The Renderer remains stateless with respect to conversation content.
- Existing Gateway session semantics can be reused without requiring a composite
  `ownerId + personaId` identity convention.
- If Gateway authorization requires `ownerId`, it still validates that the
  requested conversation session belongs to that stable owner.

## Acceptance Criteria

- Switching skins never changes the authenticated `ownerId`.
- In isolated mode, each persona restores only its mapped conversation history.
- In shared mode, persona switches retain exactly one conversation session.
- No response created before a switch is rendered or played by the new persona.
- Renderer requests contain no transcript or history payload.
- A failed Renderer session cannot cause fallback to another persona's avatar.
- Restarting the client restores conversation mappings but does not reuse stale
  Renderer session identifiers.

