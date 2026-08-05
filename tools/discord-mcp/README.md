# Discord MCP

This local stdio MCP server talks to the `DiscordMCP` LawyerCord plugin through a private file queue. Discord remains the only process that accesses the authenticated account.

## Safety boundary

- Message reads, attachment downloads, sends, deletes, and bulk reads may use any channel visible to the authenticated Discord account.
- The server has no generic REST request, membership, relationship, block, role, or moderation tool.
- Sends disable parsed mentions. Replies do not ping.
- Deletes require both the bridge's persistent sent ledger and confirmation that the authenticated account authored the message.
- Attachments are resolved from a message in a visible channel, fetched only from Discord's attachment CDN, capped at 25 MB, and hashed. Images and voice messages are also returned as native MCP image/audio content blocks so sandboxed agents can consume them directly.
- Idle operation uses an event-driven local file watcher instead of a frequent timer. Reads and downloads do not navigate Discord, display UI, or mark channels read; only explicit send/delete calls change Discord state.
- `discord_search_messages` uses Discord's authenticated channel/server search endpoints directly. Text, author, mention, media, pinned, message-boundary, sorting, and pagination filters run headlessly without opening the search UI or changing the active route.
- `discord_subscribe_channel` listens to Discord's native `MESSAGE_CREATE` stream. Agents can use `discord_wait_for_message` for up to five minutes at a time, inspect active subscriptions, and unsubscribe without REST polling or UI changes.

## Run

Enable `DiscordMCP` in LawyerCord, open its settings, select the AI apps you use under **Connect an AI app**, then restart those apps. LawyerCord installs its bundled local bridge and uses Discord's Electron runtime, so no Node.js installation or LawyerCord checkout is required.

For a manual setup, configure an MCP client to run:

```text
node tools/discord-mcp/server.mjs
```

For isolated testing, `LAWYERCORD_DISCORD_MCP_DIR` may point at a temporary bridge directory.
