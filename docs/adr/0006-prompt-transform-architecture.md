# ADR-0006: Prompt transforms run before user prompts enter the queue

**Date:** 2026-07-05
**Status:** Accepted

## Context

Voice transcription and prompt translation are separate concerns. A voice message
first becomes text in the spoken language; after that, the same prompt transform
rules should apply as they do to chat text, TUI input, and local control requests.
The bot also creates text actions itself for autopilot and recovery, and those
system-owned actions must not be rewritten by a translation model.

## Decision

Prompt transforms apply only to **User Prompts**, never to **System Prompt
Actions**. A user prompt is transformed before it enters the queue; if the
transform fails, the original prompt is not delivered. The queued message's
primary `text` remains the **Delivered Prompt**, while metadata records the
source prompt and transform details for delivery previews, logging, and later
inspection.

Translation is behind a **Translation Provider** seam. Argos Translate is the
first provider, not the prompt-transform abstraction itself. Speech transcription
stays separate: it converts voice to source-language text and does not perform
speech-to-English translation.

Prompt transform settings are scoped by **Prompt Source**: Telegram, Lark, and
Control. Telegram and Lark represent their chat adapters; Control represents
local clients such as the TUI, CLI `tcb send`, and the operator session when it
drives projects through the control socket. Dynamic source-level changes write
back to `.env` so `doctor`, setup, and manual inspection all see the same
configuration. Runtime UI can change mode and source/target languages; provider
selection and timeout remain environment-level operational settings.

## Consequences

Voice input can show a delivery preview of both the recognized text and the
delivered prompt. Text chat inputs use a lightweight translated-and-sent notice,
TUI shows translation status, and CLI keeps plain stdout clean while exposing
details in JSON mode. Queued work survives restart without needing translation
to run again, and queue deduplication can reason about the delivered prompt.
Existing system prompts, done markers, and recovery nudges are protected from
accidental translation.

The trade-off is that a queued prompt keeps the translation configuration from
the moment it was accepted; changing translation settings later does not rewrite
already queued work.

Turning on prompt translation performs a provider health check first. If the
configured provider or language pair is unavailable, the setting is not changed
and the user is told how to install or fix it; chat/TUI controls do not
automatically download models.
