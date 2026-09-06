# LawyerCord privacy notes

LawyerCord does not operate a LawyerCord telemetry or account-data service. It is still a Discord client modification, so Discord receives the normal data required to provide Discord and remains governed by [Discord's privacy policy](https://discord.com/privacy/).

Default privacy behavior:

- Discord analytics, metrics, and Sentry are disabled by the required `NoTrack` plugin.
- Cloud settings sync and source auto-update are disabled.
- `DiscordMCP`, secure messaging, voice transcription, and other optional plugins are disabled until the user enables them.
- Local plugin settings, MCP queue data, downloaded MCP attachments, and secure-messaging material are stored in LawyerCord's local application-data directory.

Features that can contact third parties:

- Cloud sync uploads the selected settings backup to the configured backend after the user authenticates and enables sync.
- Plugins for translation, media, lyrics, external uploads, themes, badges, code highlighting, transcription, and similar services may contact the provider named in that plugin's settings or source.
- The voice transcriber downloads a pinned JavaScript runtime from jsDelivr and speech models from Hugging Face; audio inference itself runs locally.
- The updater contacts the configured Git remote only after auto-update is enabled or an update is requested manually.
- The local Discord MCP server uses stdio plus a secret-authenticated file queue. It opens no listening network port, but the connected MCP host can request data from any Discord channel visible to the authenticated account.

Secure messaging encrypts message bodies and supported attachments before Discord receives them. Discord still sees metadata including participants, channel, timing, ciphertext size, attachment count, and traffic patterns. Endpoint compromise, another powerful client plugin, or screen/clipboard capture can still expose plaintext.

Review optional plugin source and settings before enabling it. This document describes the checked-in code; downstream builds can change these guarantees.
