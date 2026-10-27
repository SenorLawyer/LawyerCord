# Discord MCP

This local stdio MCP server talks to the `DiscordMCP` LawyerCord plugin through a private file queue. Discord remains the only process that accesses the authenticated account. The server exposes 70 `discord_*` tools. Every tool has a JSON schema, MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) and validates its arguments before anything reaches Discord.

## What the agent can do

Everything below works without navigating Discord or opening any UI. Any ID argument that takes a channel or message also accepts a `discord.com/channels/...` link.

| Area | Tools |
| --- | --- |
| Identity | `connection_status`, `whoami` |
| Servers | `list_servers`, `get_server`, `list_roles`, `get_role` |
| Channels | `list_server_channels`, `get_channel`, `list_threads`, `get_forum_tags`, `list_dms`, `open_dm`, `get_voice_occupants` |
| Users | `get_user`, `get_user_profile`, `find_users`, `search_members`, `get_member`, `get_message_users`, `list_relationships`, `get_presence` |
| Reading | `read_messages`, `bulk_read_messages`, `search_messages`, `get_message`, `get_pinned_messages`, `get_reactions`, `get_message_context`, `resolve_link`, `list_mentions`, `list_unread`, `download_attachment` |
| Writing | `send_message`, `edit_message`, `delete_own_message`, `delete_message`, `add_reaction`, `remove_reaction`, `pin_message`, `unpin_message`, `create_thread`, `create_forum_post`, `send_typing`, `mark_read`, `forward_message` |
| Events | `subscribe_channel`, `subscribe_guild`, `subscribe_dms`, `wait_for_message`, `list_subscriptions`, `unsubscribe_channel` |
| Gated | see below |

Lists share one shape: a named array, `count`, and `hasMore` with `nextBefore`, `nextAfter` or `nextOffset`. Messages come newest first and include author, nickname, attachments, embeds, reactions, mentions, reply reference, forwarded content, poll and thread. Results are bounded, and long text is truncated with a flag.

Messages are read from Discord's REST API so reactions and mentions are current. Servers, channels, members, roles, presence, relationships, voice and unread state come from the client's own stores, and uncached channels, users and threads fall back to REST. Rate limited requests wait for `retry_after` and retry.

## Gated actions

These categories are off by default. Each has its own switch in the DiscordMCP plugin settings, and a tool in a disabled category fails with an error that names the setting. `discord_connection_status` and the server's `instructions` report which are on.

| Setting | Tools |
| --- | --- |
| Allow relationship actions | `send_friend_request`, `accept_friend_request`, `remove_friend`, `block_user`, `unblock_user` |
| Allow membership actions | `join_server`, `leave_server`, `set_nickname` |
| Allow account actions | `set_status`, `set_custom_status` |
| Allow moderation actions | `kick_member`, `ban_member`, `unban_member`, `timeout_member`, deleting other people's messages, removing other people's reactions |
| Allow role actions | `add_role`, `remove_role` |
| Allow channel management | `create_channel`, `edit_channel`, `delete_channel` |

## Safety boundary

- There is no generic REST request tool. Every call is a fixed operation validated on the server, in the renderer and, for files, in the native process.
- Sends never notify anyone unless `allowed_mentions` asks for it. Replies do not ping by default.
- `edit_message`, `delete_own_message` and `delete_message` for your own messages check that the signed-in account wrote the message. The persistent sent ledger is kept as an audit trail.
- Every write action is rate limited with a sliding window per channel and globally (defaults 5 per 10 seconds and 60 per hour per channel, 10 per 10 seconds and 120 per hour overall). The limits are plugin settings, and a blocked call returns a clear error with the wait time.
- File uploads read only from folders listed in the plugin settings, plus attachments the agent downloaded earlier. Paths are resolved through symlinks, LawyerCord's own data folder is always refused, and files are capped at 25 MB.
- Attachments are fetched only from Discord's attachment CDN, capped at 25 MB and hashed. Downloads older than 24 hours are deleted, and the folder is capped at 500 MB. Images and voice messages are also returned as native MCP image and audio content blocks.
- Requests and responses are capped in size, authenticated with a per-install secret, and never log message content or tokens.
- Idle operation uses an event-driven file watcher. Reads and downloads do not navigate Discord, display UI or mark channels read. Only explicit write calls change Discord state.
- Subscriptions listen to Discord's native gateway events (new, edited and deleted messages and reactions) for one channel, a whole server or all DMs, with no REST polling.

## Run

Enable `DiscordMCP` in LawyerCord, open its settings, select the AI apps you use under **Connect an AI app**, then restart those apps. LawyerCord installs its bundled local bridge and uses Discord's Electron runtime, so no Node.js installation or LawyerCord checkout is required.

For a manual setup, configure an MCP client to run:

```text
node tools/discord-mcp/server.mjs
```

For isolated testing, `LAWYERCORD_DISCORD_MCP_DIR` may point at a temporary bridge directory.

## Tests

```text
npx tsx scripts/testDiscordMcp.ts
npx tsx scripts/testDiscordMcpSession.ts
npx tsx scripts/testDiscordMcpTools.ts
npx tsx scripts/testDiscordMcpNative.ts
npx tsx scripts/testProgressiveDiscordMcpLoads.ts
```
