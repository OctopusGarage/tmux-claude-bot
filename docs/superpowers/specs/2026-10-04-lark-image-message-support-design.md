# Lark Image Message Support Design

## Context

The Lark adapter currently accepts text-like messages and voice/audio messages. Other
media messages return the localized "only text and voice messages are supported"
reply. Lark message resources already have a download path that supports
`type: "image"`, but the inbound handler does not route image resources into the
agent queue.

This feature adds first-class inbound image support for the Feishu/Lark channel.
The user-selected behavior is: image messages, with optional caption text, should
be delivered to the current agent session for analysis.

## Goals

- Accept Feishu/Lark image messages from allow-listed senders.
- Download the image resource to a bot-controlled local attachment directory.
- Enqueue a prompt to the current project/session that includes the user's caption
  when present and the local image path.
- Avoid direct model-provider API calls. Image interpretation remains the
  responsibility of the active Claude/Codex session.
- Preserve the existing behavior for text, voice/audio, commands, and unsupported
  non-image media.

## Non-Goals

- No OCR-only mode.
- No direct OpenAI, Anthropic, Gemini, or other model-provider SDK/API calls.
- No outbound image forwarding changes.
- No broad attachment abstraction for every channel in this slice.

## User-Facing Behavior

When a Lark image message arrives:

1. The adapter identifies an embedded image resource.
2. The adapter downloads the image to a stable local attachment path under the bot
   state directory.
3. The adapter builds a text prompt:
   - With caption: include the caption and the image path.
   - Without caption: use a default instruction such as "Please analyze the
     attached image." plus the image path.
4. The adapter enqueues that prompt to the same session resolution path used by
   ordinary Lark text messages.

If the image cannot be downloaded, the adapter replies with a clear localized
failure message. If no current project/session is available, the existing session
resolution and no-current-project behavior applies.

## Architecture

Add a small Lark image handler near the existing voice handler boundary:

- `handlers.ts` remains the routing boundary. For non-text content, it should
  check voice/audio first as today, then image resources, then fall back to the
  existing unsupported-media reply.
- A new helper downloads the Lark image resource via
  `downloadMessageResource(..., "image")`, stores it under a state-scoped
  attachments directory, and calls `enqueueLarkAction` with a generated prompt.
- The helper should keep path rendering safe by sending `~/...`-friendly paths to
  user-visible text through existing reply boundaries. Internal queue text may use
  the actual local path if the agent needs to read the file.

The implementation should not change the core queue schema in this slice. The
queue already carries text prompts; the prompt can include the local file path
that the active agent can inspect.

## Data Flow

```text
Lark message event
  -> normalized message with image resource
  -> allow-list and group/session checks
  -> download image resource to local attachment file
  -> build prompt from caption/default instruction + image path
  -> enqueueLarkAction(..., action="text", prompt)
  -> active agent reads the local image path as part of the task
```

## Storage

Images should be stored under the app state directory in a dedicated attachment
subdirectory, for example:

```text
attachments/lark/<message-id>/<file-key-or-generated-name>.<ext>
```

The file name must avoid leaking secrets or trusting raw remote names. A generated
name or sanitized resource key is acceptable. The implementation should create the
directory on demand.

## Error Handling

- Missing Lark config: reply with the image-download failure message.
- Download failure: log the normalized error and reply with a localized failure
  message.
- Missing image resource on an image-like message: fall through to unsupported
  media.
- Unsupported media: keep the current "only text and voice messages are
  supported" behavior until a future media type is intentionally added.

## Testing

Add focused Lark adapter tests covering:

- Image message downloads the resource and enqueues a prompt.
- Image caption text is preserved in the queued prompt.
- Image without caption uses the default analysis instruction.
- Download failure replies with the localized failure message and does not enqueue.
- Existing unsupported-media behavior still returns the unsupported-media reply.

## Documentation And Alignment

Because this changes chat channel behavior, update the relevant channel support
documentation or capability matrix in the implementation slice if such a table or
user-facing media support note exists. The spec itself is not the user-facing
manual.

## Acceptance Criteria

- Sending a Feishu/Lark image to a bound/current project results in an agent queue
  item containing the image path.
- Sending a Feishu/Lark image with caption preserves the caption.
- The image file exists at the queued path when the agent receives the task.
- No direct model-provider API integration is introduced.
- Targeted tests pass.
