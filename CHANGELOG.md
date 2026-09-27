# Changelog

All notable LawyerCord changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/) with a fourth packaging revision retained while the project remains compatible with its upstream version format.

## 3.0.0.0 - Unreleased

### Compatibility

- Backups containing top-level DataStore Maps now use a versioned format requiring LawyerCord 3.0.0.0 or later. Existing IndexedDB records and backups without Maps keep their format. Older clients cannot restore these Map backups; the previous nightly may apply settings and CSS before rejecting their DataStore section. Keep an older compatible backup if downgrading.

- VoiceStats keeps new totals separately for each Discord account. Recover Old Voice Statistics adds ownerless old totals to the chosen account once and retains the original record. Older versions continue using the old record and do not read new account totals.

- ProfileSets no longer assigns ownerless legacy profiles automatically. Use Recover Old Profiles in the main profile panel to import them explicitly; the original records remain saved.

- VoiceRejoin ignores older saved channels without an account owner. Joining a call records a new reconnect target for that account.
- Older scheduled messages without an account remain saved but paused. Use Recreate to schedule a copy under the current account with its full text and attachments. The original stays paused and composer drafts remain untouched.
- Older versions do not enforce saved account ownership or attempted-send markers. Downgrading with saved scheduled messages can send them from the wrong account or repeat a previous attempt.
- BannersEverywhere now follows currently loaded Discord profile data instead of retaining historical banner URLs.

### Removed

- Remove broad friend sorting, request-date, Spotify profile and member mod-view searches. Use adjacent expressions and remove two replacement callbacks.

- Remove MessageLogger's broad renderer captures and keep its edit-handler and group-label searches within local code.

- Replace IgnoreActivities' capture-copy callbacks and broad activity searches with local bounded patterns.

- Remove GreetStickerPicker's backward props search and use its owning component's arguments for the context-menu callback.

- Remove FakeProfileThemes' broken copy button from the newer profile editor. It received no colors and failed when clicked. The plugin settings and older theme editor retain their copy controls.

- Replace FakeNitro's message-accessory, emoji-eligibility and gradient-theme capture-copy callbacks with direct replacement strings.
- Remove FakeNitro's broad emoji/sticker notice searches and their capture-copy callbacks. Keep the sticker marker in the outer component's props binding.

- Remove ContextMenuAPI's special exception that hid patch syntax failures from logs and companion reports. Failed replacements still roll back.

- Remove redundant ReplyTimestamp date casts, its single-use state enum, and the repeated same-day calculation.

- Remove redundant outer exception handling from CrashHandler while preserving recovery when Discord notifications or APIs fail.

- Remove the ineffective RichPresence settings rename call. Existing per-service settings migration is unchanged.

- Remove CallTimer’s single-use text wrapper and move its static styles into the existing stylesheet.
- Remove CustomSounds' Debug action, which dumped stored audio and file details to the console.

- Remove duplicate ProfileSets storage state, startup loading, comparison code, profile-effect copying, unused arguments, separators, and styles. Use the shared file utilities for import and export and shared TextInput for pagination. Remove redundant input theme and focus overrides. Use separate shared buttons for loading presets and opening their options.
- Replace USRBG's two-choice banner-priority dropdown with a boolean toggle, preserving saved preferences.
- Remove redundant banner URL and status-error toast construction, the unused FriendTags stylesheet, and TidalEmbeds' duplicate accessory dependency.
- Remove the unused SVGO development dependency and its release-age exception.
- Remove TriviaAI, which required a user-supplied API key and arbitrary AI endpoint. Its Answer With AI actions are no longer available.

### Fixed

- Restrict hidden app-channel toolbars to notifications, matching hidden text and forum channels instead of showing unavailable channel controls.
- Keep hidden-channel fetch and keyboard-navigation patches local to their channel checks and list construction, removing broad searches and replacement callbacks.
- Restore the allowed-user list button in hidden channels and announce its actual user count, passing the channel to the components that need it.
- Simplify hidden-channel role selection and keep permission-list captures local, preserving which allowed roles and users are displayed.
- Preserve the native divider in visible stage-channel headers while hiding counts in hidden stages, and narrow voice-content and permission-header patch searches.
- Hide chat toasts when viewing hidden stage channels, and simplify stage-rendering patches to use local channel references.
- Fix voice-channel mentions so visible channels can join normally and hidden channels navigate without joining instead of doing nothing.
- Remove a disabled channel-store filter while retaining channel counts, and simplify discovery and active-status patches without changing their output.
- Show the highest role in member mod view before enhanced-member data loads, using the existing role subscription and removing the redundant lookup and helper.
- Use the correct friend when showing friendship dates, and apply dates to both regular and anniversary rows.
- Restore voice indicators on regular and anniversary friend rows, using each row's own user and hover state.

- Replace hidden-channel toolbar method-prefix searches with local button matches and keep the nested row guard tied to its mouse handler's channel.

- Use local row-return matches for hidden-channel muted and unread assignments, removing their backward searches and three replacement callbacks.

- Keep hidden-channel eye and lock icon captures near their channel label and remove their replacement callbacks.

- Bound ShowHiddenChannels' render-level matches and keep voice navigation tied to the adjacent selection call, removing five replacement callbacks.

- Read voice-user and reactor role colors from their component props, removing backward searches through unrelated code.

- Match role headings and poll labels directly, preserving role icons and accessibility text, and bound role-color mention captures to their own function.

- Keep PlatformIndicators' mobile-mask search inside the status switch and remove ReverseImageSearch's backward target lookup.

- Make the collapsible Direct Messages heading reachable by keyboard, support Enter and Space, and expose its expanded state.

- Bound PinDMs' section, renderer, row-height and scroll captures to their nearby code while preserving its generated patch output.

- Make Pause Indefinitely keyboard accessible and wait for the server before checking the paused state. Report failed requests and allow retrying.

- Remove PauseInvitesForever's extra setter patch and use the adjacent checkbox's setter directly.

- Keep OnePingPerDM's sound capture and OpenInApp's account capture inside their target callbacks instead of searching unrelated code.

- Apply new-server defaults in the accepted invite handler using its guild ID. Stop the patch from modifying the unrelated app-opening method.

- Use Discord's native list class for MutualGroupDMs' sidebar and replace its long cross-function capture with a bounded section match.

- Add MutualGroupDMs to the actual profile tabs before initial selection and render its selected section correctly. Stop its tab patch from injecting into a wishlist card.

- Preserve Pending and other Discord friend headings when ImplicitRelationships adds its own count. Keep its section and sorting patches local.

- Target FakeProfileThemes' store patch at the actual profile store so another module cannot consume it first, and bound the older theme editor's button search.

- Bound FakeNitro's embed, sticker, attachment and soundboard patch searches. Keep emoji-eligibility captures within their owning function.
- Match FakeNitro's gradient-theme update at the local call instead of searching forward from a function declaration.

- Bound Decor's purchase-label and current-user captures to their local render code.

- Keep Experiments' toolbar-handler and experiment-name patches within their nearby code instead of searching into later functions.

- Preserve explicit empty avatar-decoration previews in Decor. Custom decorations apply only when no override was supplied.

- Restrict the inbox menu patch to its arrow-renderer module so another reminder menu cannot consume it first.

- Pass Emoji Studio props to context-menu plugins while preserving its popout close and reset callbacks.

- Pass inbox reminder and channel menu props to context-menu plugins instead of inherited webpack module arguments.

- Bound ContextMenuAPI's argument-injection search while preserving its captured matches and removing redundant callback-source checks.

- Match MemberCount's member-list class exactly instead of accepting unrelated class names containing "members".

- Keep MemberCount and MentionAvatars patch searches near their target expressions, preserving ShowMeYourName integration.

- Forward translation cancellation to DeepL and Kagi native requests. Scope cancellation by invoking frame and request ID so another window cannot cancel unrelated work.

- Cancel transcript translation on replacement, Cancel, unmount, logout, and plugin stop. Pass its own signal to Google translation without reusing the terminated speech worker.

- Cancel replaced Translate Google requests and abort received/outgoing Google requests on logout or plugin stop. Cancelled sends retain their original text without failure feedback.

- Reject Kagi translation request bodies larger than 128 KiB before sending them, matching the existing DeepL payload limit.

- Cancel obsolete TranslatePlus provider requests when replaced, when their last view closes, on logout, or when the plugin stops. Keep shared dictionary downloads available to surviving requests.

- Preserve session names saved in another window when renaming, discovering sessions, or dismissing new-session badges. Apply each operation to the latest stored Map instead of replacing it with the local cache.

- Preserve malformed BetterSessions records instead of treating them as empty or overwriting them during later saves. Validate stored session names again inside the write transaction.

- Keep premium-offer and reply-timestamp patches local to their target expressions, without relying on offer field order or crossing unrelated objects.

- Keep IrcColors hash results as CSS colors, including a zero hash, while preserving nullable inputs used by name mentions.

- Update visible IrcColors names immediately when either color-filter setting changes, without waiting for another Discord render.

- Make the IrcColors message-color patch independent of destructuring property order and prevent it from scanning into another scope.

- Keep LoadingQuotes patches local to each quote selection so a changed normal initializer cannot redirect the patch into event quotes.

- Let BetterSessions start when an older backup has already replaced its saved names with an empty object. Names lost by the old backup cannot be recovered.

- Stop pending cloud uploads before selecting account data when the Discord account or cloud service changes during storage reads.

- Prevent cloud uploads, downloads, and deletion from overlapping across windows that share browser storage. Busy automatic syncs retry through the existing scheduler.

- Preserve the actual written or deleted keys in DataStore change notifications when callers mutate their key arrays before a transaction finishes.

- Retain committed plugin-data changes made before cloud sync starts, so initialization does not miss an automatic upload.

- Schedule automatic cloud sync after committed plugin-data changes in the current window. Failed writes, custom databases and local-only records do not trigger uploads.

- Keep automation workflows and execution state local during cloud sync so another device cannot start copied workflows automatically. Use the existing workflow export/import or an explicit offline backup to transfer them.

- Preserve top-level DataStore Maps, including BetterSessions names, through offline and cloud backups. Reject malformed Map metadata before importing any section, and reject older empty-object session records instead of overwriting current names.

- Restrict BetterSessions cloud transfers to the signed-in account and preserve other accounts’ stored session records.

- Keep the BetterSessions rename dialog open when saving fails, allow retry, and update the displayed name only after storage succeeds. Ignore retained callbacks after an account change.

- Snapshot BetterSessions data before saving so account switches, logout, or later edits cannot change an already queued save.

- Keep RelationshipNotifier observation history local so its saved maps cannot block cloud sync or overwrite another device's offline-change baseline.

- Keep plugin credentials, saved decryption passwords, ShareX configurations, and their service connection settings local during cloud sync. Older cloud backups cannot replace them or redirect retained credentials to another server.

- Keep ChannelTabs session state local and sync only the current account's bookmarks and tab presets. Cloud imports preserve other accounts' saved bookmarks, including concurrent changes.

- Sync VoiceStats and ProfileSets records only for the signed-in account, preserving other accounts and ownerless recovery data. Exclude ReviewDB authorization records from cloud transfers.

- Keep ThemeLibrary, Decor, SongSpotlight, and Streaks authorization tokens out of cloud uploads and imports.

- Keep scheduled-message queues, reconnect and last-channel state, and downloaded transcription models out of cloud transfers. This prevents copied jobs from sending on another device and model caches from blocking cloud serialization.

- Include QuickCSS edits in automatic cloud uploads using the existing sync preferences and debounce.

- Keep CSS and stored-data changes made during cloud sync dirty instead of reporting an older upload as current.

- Retain accepted cloud upload versions after concurrent settings edits or partial server failures so retries use the correct checkpoint.

- Preserve local data during upload-only cloud sync and keep skipped remote changes available for an explicit download.

- Keep Picture in Picture button matching independent of the order of Discord media properties.

- Make the Picture in Picture control keyboard-accessible with the shared button and an explicit accessible name.

- Stop detached PiP videos and ignore stale request or playback completion after another video replaces them.

- Discard an older pending Picture in Picture metadata load when another video is requested, preventing it from replacing the newer video.

- Preserve mute, volume and playback speed when opening a video in Picture in Picture.

- Remove failed Picture in Picture clones when video metadata cannot load and report the failure without interrupting the original.

- Keep the original video playing when Picture in Picture or cloned playback fails. Remove failed clones, close an already-open PiP window and report the failure.

- Narrow the badge, emoji autocomplete and message-button patches so they no longer scan arbitrary code spans.

- Look up CrashHandler's modal and draft modules independently so a temporarily missing module remains retryable.

- Limit crash-recovery draft clearing to channel and first-thread messages. Preserve polls, commands, thread settings, interaction-modal and scheduled-message drafts.

- Release CrashHandler's recovery guard after disabled, failed or rate-limited attempts so later crashes can recover.

- Save changed channels immediately and remove KeepCurrentChannel's delayed saves and shutdown flushes, preventing an older window timer from undoing crash cleanup. Repeated selections remain skipped.

- Ignore malformed saved KeepCurrentChannel records during restoration without rewriting them.

- Reset KeepCurrentChannel’s in-memory state on startup so a failed read cannot overwrite newer saved data and a previous account switch cannot disable tracking.

- Prevent pending channel saves or startup reads from undoing crash cleanup. KeepCurrentChannel now ignores stale restoration after navigation, logout or shutdown and reports storage failures.

- Preserve nested crash-state expressions in CrashHandler and narrow ConsoleJanitor’s deprecated-log match.

- Report failed BetterSettings preloads without unhandled promise rejections, while preserving retries when settings are opened.

- Preserve native dialog roles, localized labels and layer identifiers when BetterSettings disables fades.

- Apply BetterSettings modal animation changes together, tolerate reordered properties and remove the unused style prop.

- Narrow BlurNSFW message matching while preserving its existing restricted-preview behavior.

- CallTimer expands only the containers holding its connection timer, preventing overflow without resizing unrelated panels.

- CallTimer resolves the current voice-row color classes instead of using obsolete hardcoded names.
- CallTimer applies self-tracking, format, seconds and role-color changes immediately without waiting for another voice event.
- CallTimer reads the current user from component props instead of scanning through the voice-icon renderer.
- Narrow chatbox mention matching and make ColorSighted status matching independent of prop order.
- Narrow NoMosaic attachment matching and remove PlainFolderIcon’s unnecessary replacement callback.
- BlurNSFW accepts blur-amount changes while disabled and applies the latest value when enabled.
- BetterSettings identifies its context-menu entries directly without searching through surrounding declarations.
- CustomSounds invalidates deleted audio in other active windows, and previews read current storage even while the plugin is disabled.
- BetterSettings keeps the collectibles shop lazy instead of loading it with settings.
- BetterRoleContext and BetterSettings identify their popout and fade-layer exports locally instead of searching through surrounding functions and classes.

- BetterFolders matches its guild-bar dependency entry directly, reads expanded state from existing folder props, and bounds its surrounding patch searches.

- AlwaysAnimate preserves CSS class-name strings instead of replacing them with animation flags. Its generic replacements now use bounded searches.

- AccountPanelServerProfile matches its popout callbacks directly, and AlwaysAnimate bounds its status-emoji patch search.

- ShowMessageEmbeds targets the attachment parser instead of unrelated attachment renderers. Its context-menu match and the Timezones message-header match now use bounded searches.

- RPCEditor validates the actual stream-link destination and allows clearing an optional stream URL.

- RPCEditor preserves newer settings saved by another window and processes local saves in order. Conflicting edits report that a reload is needed.

- RPCEditor reports failed saves while retaining edits for another save attempt.

- RPCEditor rejects malformed saved lists without overwriting them or breaking activity updates, and allows adding an entry to an empty saved list.

- RPCEditor loads saved entries before allowing edits while disabled, preventing an empty settings view from replacing the saved list. Failed reads keep editing unavailable and report the failure.

- RPCEditor preserves dollar-sign sequences literally when inserting activity text into templates, and targets its activity-update patch without depending on event field order.

- UnreadCountBadge shows thread badges even when there are no mentions or voice users, and updates when mute preferences or its display settings change.

- MoreStickers keeps channel and composer checks when highlighting its extra picker button and bounds the picker-panel patch.
- MoreUserTags removes a discarded native label lookup and unbounded patch searches. MessageLoggerEnhanced locates its fetch callback and image state directly.
- MoreStickers changes the correct click handler so its extra button opens the added sticker picker instead of Discord's normal picker.
- CustomUserColors locates message color props without depending on field order or searching across arbitrary surrounding code.
- FastDeleteChannels shows the shortcut action on threads without mentions or voice users, clears it when the window loses focus, and uses an accessible button with failure feedback. Its hooks are isolated from Discord renderers.
- Cloud sync preserves backend changes saved by another window and advances the renderer sync timestamp only after persistence succeeds.
- Cloud imports reject newer persisted settings instead of overwriting them. Failed saves leave renderer settings unchanged, and sync checkpoints preserve unrelated saved fields. Web settings writes share a lock across windows.
- Cloud downloads preserve QuickCSS and DataStore edits made while synchronization is pending. Conflicting DataStore batches abort together, and web QuickCSS is no longer written twice through separate cloud records.
- Legacy cloud downloads no longer use a local edit timestamp as a server cache validator, which could incorrectly skip different settings with the same timestamp.
- Cloud reauthorization stays tied to the account and backend that started it and stops if cancelled during credential deletion.
- Automatic cloud uploads retry through the existing debounce when another cloud operation is busy, instead of losing the scheduled upload. Retries recheck cloud sync preferences.
- SupportHelper bounds the contributor-DM warning patch while preserving the selected channel.
- Support diagnostics identify LawyerCord and link to the configured repository. Support buttons show LawyerCord commands and recognize both current and legacy command names.
- CommandsAPI uses the adjacent command description to locate the plugin label instead of an unbounded backward search.
- CommandsAPI recognizes longer minified identifiers, and UserSettingsAPI bounds its setting-definition patch search.
- ContextMenu targets the menu handler directly and reads component registrations without an unbounded backward patch search.
- MessagePopover keeps each button's error boundary tied to its plugin, so hiding a failed button does not hide a healthy neighbor.
- MessagePopover bounds its patch searches while preserving plugin-button order and reaction visibility.
- MessageDecorations and ServerList use bounded patch matches, preserving their output on the captured Discord modules.
- MessageEventsAPI runs awaited pre-edit hooks for component-message edits as well as plain text, preserving hook cancellation and content changes.
- MessageEventsAPI makes Discord's send-validation callback asynchronous before adding awaited hooks, keeping the patched module valid and allowing hooks to cancel sends.
- CustomSounds ignores malformed restored audio records without deleting them and preserves replacements made during legacy conversion.
- Cloud deletion processes one record at a time and stops before further deletions after a failure or an account or backend change.
- Malformed cloud JSON responses report a fixed error instead of copying response excerpts into logs and notifications.
- Changing cloud backends preserves saved credentials. Disabling cloud integration cancels pending authorization. Reauthorize still clears the selected backend's credential before reconnecting.
- ImageFilename targets the image link directly, and NoRPC removes only its native transport registration callback. Both patches avoid unbounded searches across surrounding code.
- CustomSounds applies seasonal overrides to incoming seasonal sounds and ignores inherited object names in saved sound selections.
- CustomSounds saves selections before loading playback data, so pending selection loads cannot undo Reset All.
- CustomSounds keeps completed uploads available without letting late uploads or deletions overwrite resets or newer edits.
- CustomSounds validates saved overrides before using them and falls back safely without rewriting malformed stored values.
- CustomSounds ignores settings imports superseded by a reset, newer edit, another import or closing the editor.
- CustomSounds exports all sound settings, preserving disabled overrides with saved volume or file choices.
- CustomSounds previews require a selected custom file, resolve built-in overrides consistently and apply volume changes after saving them.
- CustomSounds preloads custom audio from one database snapshot instead of rereading every saved file for each sound.
- CustomSounds previews accept uploaded MP4 data with video MIME types and exclude malformed stored values from playback.
- CustomSounds releases cached playback data on stop, reset and file deletion, and ignores stale loads that finish afterward.

- CustomSounds stops previews when the editor closes and prevents pending loads from playing after Stop or a changed selection.

- CustomSounds shares one file-name list across sound rows, so uploads and deletions appear everywhere without retaining repeated audio payloads.

- CustomSounds preserves concurrent audio uploads and deletions, avoids phantom files after failed saves, and prevents stale legacy conversions from restoring replaced files.

- CustomSounds detects audio types when a file has no MIME type and rejects cancelled reads instead of saving an invalid sound.

- Queued plugin setting edits no longer overwrite newer imported values, and repeated typing stays debounced across modal rerenders.

- Resetting plugin settings refreshes open inputs and prevents older queued edits from undoing the reset.

- CustomTimestamps restores its original formats when Reset Settings is used.

- CustomTimestamps applies saved format changes immediately, including static timestamps and calendar subformats.

- CustomTimestamps expands repeated placeholders without rewriting literal labels or escaped brackets, and skips refresh timers for static labels.

- CustomTimestamps no longer changes the parent component's hook order when timestamp tooltips are hidden or an application preview replaces them.

- CustomTimestamps keeps its relative-time thresholds local instead of changing date formatting elsewhere in Discord.

- CustomFolderIcons applies saved icons, size changes, background settings and resets immediately without requiring a hover.

- ClientSideBlock restores hiding for current direct-message rows while preserving group and system conversations.

- ClientSideBlock hides role headers only when every displayed member is loaded and hidden, preserving headers for incomplete groups.

- ClientSideBlock keeps saved user and guild ID lists consistent when a setting changes before initialization or after stopping.

- ClientSideBlock filters current Active Now cards without changing shared party data. Cards containing locally hidden users are hidden as a whole, with voice settings and guild exceptions respected.

- ClickableRoles member rows use Discord keyboard controls for opening profiles.

- ClickableRoles refreshes membership when opened, ignores replies from an earlier account or stopped plugin, and distinguishes lookup failures from empty roles.

- ChannelBadges shows thread badges even when the thread has no mentions or voice participants.

- BetterBanReasons opens the custom input correctly and keeps preset message deletion durations local to each ban dialog.

- Apply StreamingCodecDisabler choices to outgoing-stream codec advertisements instead of calling unavailable engine setters. Preserve decoding, watched streams, camera calls, and original engine capabilities.

- Build CustomStatusTimeouts choices when status and quiet-mode menus render so settings changes apply without reloading. Remove the ineffective timeout cache and leave Discord's shared options unchanged. Remove repeated duration choices across Discord defaults and custom units, and omit custom durations that overflow or cannot form a valid millisecond expiration.

- Restore the StatusPresets menu insertion in the current account popout and export its menu component without matching across neighboring functions. Keep custom-emoji presets deletable without Nitro.
- Keep malformed status presets visible by saved name and deletable without rendering their invalid fields. Preserve unreadable preset collections and prevent saving over them. Reject malformed saved emoji values before applying a status preset, while retaining the saved record. Restore presets saved with Discord's Don't clear option.

- Limit UserPFP avatar database downloads to 30 seconds and streamed responses to 5 MiB, release unread response bodies after HTTP failures, and keep raw response errors out of logs.

- Preserve Discord's avatar format and WebP arguments when UserPFP falls back to the original avatar function or substitutes a global avatar for a server avatar.
- Share UserPFP URL handling between global and server avatars so malformed overrides fall back and static GIF requests are rewritten consistently. Preserve folder names and non-GIF filenames.
- Allow local GIF and WebP avatars through the existing file-upload path without requiring an external image host. Reject newly selected files above 10 MiB before reading them.
- Keep the UserPFP avatar editor open when Save is pressed while a selected image is still loading. Delete cancels the pending read. The upload control is keyboard accessible, and Enter saves only from the URL field.

- Reject malformed USRBG feed records and unsupported image endpoints, cancel stopped, superseded, or timed-out loads, and prevent older responses from replacing current data. Keep feed URLs inside a single quoted voice-background image. Honor the voice-background setting for tile styling, remove the CSS-name heuristic, and preserve incoming tile props. Update the current video-background patch so Discord profile-theme backgrounds do not cover USRBG banners.
- Bound decoded USRBG feed responses before parsing and cancel oversized downloads.

- Attach CopyStatusUrls to both current status-button layouts without targeting earlier unrelated buttons.
- Narrow banner patch anchors and bound the TIDAL embed patch using current public Discord modules.
- Subscribe member-list banners to Discord profile changes and animation settings. Keep banner and nameplate preference decisions aligned within each row render.
- Keep banner conversion results attached to their source image. Preserve third-party URLs and the original image on failure, and allow failed conversions to retry.
- Clean up pending banner conversions on stop, cache eviction, or a 30-second timeout. Limit conversion canvases to 1,024 pixels per dimension while preserving aspect ratio.
- Keep unsupported TIDAL URLs visible and render every supported player in messages containing multiple TIDAL embeds.
- Limit embedded ProfileSets images to 10 MiB before preparing snapshots or applying presets. Preserve explicit field removals when updating saved profiles.
- Validate stored and imported ProfileSets fields before use, retain invalid records, and stop migration on malformed account records. Preserve newer migration destinations and legacy backups.
- Publish ProfileSets changes only after storage succeeds. Reject overlapping or stale-client writes, wait for pending writes before reload, and retain the original update target during preparation.
- Keep ProfileSets reads, saves, imports, and pending loads within their originating account, section, and list. Give each panel its own list so main and server loads cannot replace each other or export the wrong section. Reload on account changes, reject stale load and export callbacks, cancel dismissed imports, and reject outdated menu actions.
- Report ProfileSets failures, recover save controls after preparation errors, contain rendering failures, and wait for custom-status updates. Closed panels no longer show load-failure notifications, and late saves cannot alter a replacement panel.
- Reject failed profile-image downloads without retrying guild-specific hashes as global images, apply a 30-second request timeout, and enforce a 10 MiB streaming limit before conversion. Use shared URL helpers for banners and guild avatars, and preserve prepared avatar data when saving. Prepare wrapped image URLs and temporary blob URLs through the same bounded download path. Simplify image preview payloads and honor explicit avatar removal. Send prepared images through Discord's current pendingImage field and include their MIME type for animated-avatar checks. Preserve existing bio and pronouns when a preset omits those fields, and restore saved accent colors without losing pending removals. Honor explicit appearance and custom-status clearing while preserving omitted fields and server-profile isolation. Preserve pending text and image removals when saving global and server profiles. Read pending edits only from the selected profile scope.
- Keep ProfileSets pagination aligned with searches, saves, imports, and shrinking lists. Keep row identity, loading, selection, and renaming attached to their preset, reject stale row loads, and avoid repeating the previous random selection.

- Reject future-dated VoiceRejoin records after a backward system clock adjustment. Skipping an automatic reconnect no longer marks a newer saved session inactive. Disconnects only clear sessions saved for the same account. Reconnect through Discord's normal channel action so its join checks and current channel metadata apply.

- Keep VoiceStats session durations independent of system clock adjustments.

- Stop VoiceStats timers and session counting on logout.

- Restore the current custom-status emoji in the StatusPresets menu.

- Keep automation blocks with unknown saved event types editable instead of crashing their output-field lookup.

- Restore IgnoreActivities controls in the Registered Games overflow menu and remove the obsolete game-row patch.

- Refresh ClientSideBlock, StatusPresets, and MessageLoggerEnhanced patches for current Discord module shapes.

- Update Timezones' profile patch to the current Discord profile module shape.

- Update stale RPCEditor, NewGuildSettings, and OnePingPerDM patches to the current upstream Discord module shapes.

- Allow retained attempted scheduled messages to be retried explicitly from the queue without showing stale results after an account switch. Reject stale cross-client writes before overwriting messages or marking a send attempt, and provide Reload to refresh the queue before retrying.

- Update stale FriendCodes, MoreUserTags, and FakeNitro patch anchors and remove InvisibleChat's silent patch exception.

- Render duplicate stored FriendTags user IDs once without rewriting saved tags.

- Report failed FriendTags saves without leaving rejected promises unhandled or showing stale warnings after stop.

- Keep duplicate-named FriendTags distinct when deleting tags or using context menus, and preserve other editor rows after deletion.

- Stop FriendTags from saving on editor mount, edit the selected tag when names match, and remove complete user IDs.

- Keep failed FriendTags saves eligible for a later retry. Preserve invalid stored tags, wait for loading before editing, and ignore reads from stopped plugin instances.

- Remove redundant frequency-setting reads from quick-switcher searches and skip unavailable or nameless channel records.

- Fix FollowVoiceUser menu crashes when eligibility changes and clear following on logout or account switching.

- Match filename extensions regardless of casing and preserve compound tar extensions when anonymizing.

- Bound random filename lengths and recover invalid saved anonymization methods without producing missing filenames.

- FindReply searches current replies when clicked, excludes non-reply message references, and retains direct replies sent within the same millisecond. Closing its navigator releases the controls and click listener. Older controls are cleared when a new search has fewer than two replies or its container is unavailable. Container lookup resolves Discord's CSS classes instead of assuming a hash suffix.

- Restore FindReply navigation after re-enabling the plugin and wait for its paginator to load.

- Update Stylelint's colord dependency to fix slow rejection of malformed color strings.

- Validate stored scheduled-message records before loading them, preserving invalid data and blocking queue changes until it is recovered.

- Keep a pending scheduling save from restoring previews after shutdown.

- Parse the full scheduling delay, preserving fractional minutes and rejecting invalid numeric values.

- Ignore repeated scheduling submissions while saving and allow retry after a failed save.

- Report failed scheduled-message deletions without clearing the list or showing feedback after an account switch.

- Show failed scheduling saves in the dialog while preserving its draft and attachments.

- Commit scheduled queue mutations in order and publish them only after storage succeeds, preventing failed additions from being sent or persisted by later saves.

- Keep other accounts out of the scheduled-message list and preserve their entries when clearing the queue.

- Count scheduled-message limits separately for each account.

- Reset scheduled-message work on logout and restore the current account after reconnecting.

- Remove unused scheduled-message rescheduling and channel-filter helpers.

- Reject invalid and past scheduled dates before changing the queue or its previews.

- Restore scheduled-message previews only for their saved account.

- Reject scheduled sends from another account and pause older entries whose account is unknown.

- Record the initiating account on new scheduled messages and avoid restoring previews after an account switch during saving.

- Preserve composer uploads changed while a scheduled message is being saved.

- Clear only the scheduled channel draft when its text still matches, instead of clearing the last active editor.

- Keep an open scheduling dialog from acting on a different account or clearing its composer.

- Keep closed scheduling dialogs from clearing drafts or uploads, showing save results, or mutating modal state after an in-flight save finishes.

- Discard pending scheduling attachment reads after an account change or plugin shutdown.

- Check patch definitions with quoted keys or whitespace instead of skipping them before parsing.

- Inspect individual patch properties so compact formatting cannot hide lint errors.

- Limit patch lint to patch definitions instead of flagging unrelated URL rewrite rules.

- Remove an invalid, ineffective transform from the hidden-message indicator.

- Report attachment read failures instead of opening a schedule with missing files.

- Stop scheduled reaction retries when the initiating account changes.

- Use the configured check interval for overdue scheduled messages that cannot currently send.

- Keep scheduled sends from proceeding under a different account after saving queue state.

- Stop pending scheduled sends and their follow-up notifications when the initiating account changes.

- Suppress scheduled reactions and notifications after shutdown while preserving successful-send cleanup.

- Prevent scheduled message requests from starting after shutdown during storage or attachment loading.

- Stop automatic scheduled-send batches from starting another message after shutdown.

- Stop restoring scheduled previews after cleanup or an account change, and skip messages removed during restoration.

- Wait for scheduled preview insertion before reporting completion and log preview failures without message content.

- Ignore delayed scheduled-message previews after cleanup, replacement, or an account change.

- Ignore stale scheduled-message storage reads after newer loads, queue edits, or shutdown.

- Reschedule interval changes without starting the scheduled-message plugin while it is disabled.

- Prevent a pending scheduled-message startup from restarting the scheduler after the plugin is disabled.

- Preserve attempted scheduled messages until sending succeeds and prevent automatic retries after failed or interrupted attempts.

- Stop scheduled messages from sending with missing attachments when an upload fails.

- Remove redundant sticker category wrappers that assigned the same React key to every pack.

- Use CSS for sticker settings hover styling and give the icon button an accessible name.

- Remove duplicate sticker search state and its shared timer so clearing search cannot restore an older query.

- Reuse shared async loading for recent stickers, removing the manual loader and handling failures and unmounts.
- Derive the sticker inspector’s pack label from the hovered sticker, removing stale duplicate selection state.
- Use the shared async hook for sticker picker loads and derive its sidebar from loaded packs, removing duplicate state and effects.
- Handle partial sticker settings load failures and ignore completions after the settings close.
- Preserve pending replies during sticker conversion and upload failures, and clear only the matching reply after a successful upload message post.
- Insert sticker links without duplicating existing draft text or clearing a pending reply.
- Handle sticker conversion, upload, and message-post failures without unhandled rejections or stale-account notices.
- Stop stale sticker sends after the active Discord account changes during conversion or upload.
- Keep sticker conversion input and output filenames distinct and reject failed FFmpeg executions.
- Load FFmpeg only for animated sticker conversions and terminate each worker afterward. Remove the picker’s FFmpeg state and context.
- Save sticker payloads and metadata atomically, and delete packs and recent entries in one transaction.
- Reject malformed saved sticker metadata while preserving the original records.
- Normalize missing sticker pack titles without mutating the imported object, and remove the single-use metadata conversion helper.
- Reject malformed or mismatched stored sticker packs without deleting the stored records.
- Validate every sticker pack in an imported file before saving any of them.
- Refresh sticker settings after migration, handle storage failures, and remove the unused recent-sticker setter.
- Allow interrupted sticker migrations to resume without replacing current packs or recent stickers.
- Report incomplete sticker migrations once and retain legacy recent stickers while packs remain unmigrated.
- Match migrated LINE emoji IDs and sticker pack references to the current importers.
- Preserve custom sticker packs during legacy migration and stop deleting saved packs when migration cleanup fails.
- Store sticker pack payloads under dedicated keys so imported IDs cannot overwrite unrelated settings. Keep legacy payloads intact while hiding deleted packs.
- Remove the unused dynamic sticker pack refresh function and its credential forwarding path.
- Fetch audio directly for visualizations instead of forwarding audio URLs through a third-party proxy.
- Stop automatically uploading legacy Streaks records that lack an owning account. Preserve the local records.
- Remove Navidrome instance artwork sharing to keep server authentication out of Discord asset requests, and migrate existing selections to None.

- Remove SupportHelper execution of JavaScript snippets from messages and embeds while preserving diagnostic actions.
- Preserve successful webpack patches and their diagnostics when later replacements fail.
- Resolve bulk webpack lookups when multiple matches share one module.

- Finish removing retired Questify auto-completion code, network handlers, and the related ChannelTabs animation. Preserve quest browsing preferences and genuine progress displays.

- Remove unused message logger native write handlers, cache exposure, and obsolete types.

- Remove unused MarkdownTables parser entry points and a dead helper.
- Retain outgoing MessageBurst text until the edit resolves, and remove its unused popover dependency.
- Preserve Source resolution when changing screenshare frame rate.
- Keep InvisibleChat decryption local by removing automatic URL preview requests to Discord.

- Cancel instant screensharing when its selected source is unavailable instead of sharing a different screen or window.
- Use the managed message hook for Ingtoninator so its API dependency and cleanup are handled automatically.
- Remove the empty contact-history startup wrapper and its unnecessary async yield.
- Preserve saved hidden servers when the plugin stops before loading finishes, and flush only pending edits.
- Preserve existing Chromium feature flags when applying startup workarounds.
- Remove an unused native download helper and correct the pull request release instructions.
- Preserve literal CSS in userscript builds and remove obsolete browser editor metadata and About page scripting.
- Use native integer decoding for extension headers and reject truncated archives.
- Bound React DevTools extension downloads and ZIP expansion before extraction, reject duplicate or unsupported archive entries, and clean partial output after failed extraction.
- Stage React DevTools extensions outside the final cache path and promote them only after extraction completes.
- Resolve cancelled file pickers and release their temporary inputs.
- Simplify extension extraction, reject paths outside the extension directory, and finish cleanup before reporting installation failures.
- Await backup file imports, preserve empty QuickCSS backups, and remove backup-content logging and duplicate import handling.
- Fail full backups when required data cannot be read, and read only the requested sections for partial backups.
- Reject DataStore backups and cloud uploads when the JSON format would discard stored values, and show the export failure reason.
- Await desktop backup saves so native save failures reach the export error handler.
- Validate all selected backup sections before applying any settings, CSS or DataStore writes.
- Reject malformed core settings and plugin containers before importing a backup, while preserving unknown plugin fields.
- Preserve the previous desktop settings file and main-process settings when saving fails, and report the failure to the caller.
- Wait for local settings saves before reporting legacy cloud synchronization as successful.
- Restore cloud DataStore bundles through the backup validator and synchronize cleared QuickCSS values.
- Advance the cloud sync manifest only after local settings are saved, allowing failed saves to retry downloads.
- Keep cloud credentials and sync bookkeeping local during cloud uploads and restores.
- Keep the active cloud configuration local and exclude its sync timestamp from uploaded settings, while preserving it in explicit offline backups.
- Bind credential reads and mutations to their starting account, reject changed or missing cloud authorization, and preserve newer credentials during legacy migration.
- Discard obsolete OAuth results after account or service changes, deauthorization, cancellation or a newer authorization attempt.
- Validate cloud OAuth configuration and callback destinations, handle credential-read failures, and reject unsuccessful authorization responses.
- Time out stalled cloud authorization configuration and callback requests.
- Limit streamed cloud authorization responses before parsing or saving credentials.
- Stop cloud settings deletion after an account or service change and keep its authorization bound to the original service.
- Discard obsolete cloud upload and download results, stop later import stages after account changes, and keep fallback requests bound to their starting service.
- Keep full cloud erasure bound to its starting account and report request or storage failures without deauthorizing a newly selected account.
- Store cloud sync manifests separately for each account and service, preserve ownerless legacy records, and keep scoped checkpoints out of cloud transfers.
- Reject malformed cloud sync responses and unsupported downloads before local writes, and validate deletion manifests before deleting entries.
- Validate all cloud download payloads before applying any section, and restore legacy DataStore records through the shared batch importer.
- Reject invalid legacy cloud timestamps before applying settings or saving checkpoints, and omit cache validation on forced downloads.
- Save cloud connection preferences locally without treating them as synchronized-content edits or scheduling uploads for them.
- Start tracking settings edits before cloud startup awaits so disconnected or failed initialization does not disable later automatic uploads.
- Check the current account's cloud credential at startup and discard stale authorization results after account or service changes.
- Preserve settings edited during an in-flight sync and retain their pending-upload marker until a later upload succeeds.
- Prevent overlapping cloud sync and deletion operations in the same client, and tell users when a manual action must wait.
- Time out stalled cloud requests, report transport failures, and wait for deletion batches to settle before allowing another operation.
- Bound streamed cloud sync JSON, deletion manifests and upload acknowledgments before parsing them.
- Stream legacy cloud backup decompression with limits on compressed and expanded data before importing settings.
- Explain that runtime backup import failures can leave some changes applied, while retaining the underlying error for diagnosis.

- Honor the default two-way cloud sync direction and remove unreachable startup warnings and unused notification code.

- Keep cloud sync failures retryable and report failed downloads or deletions instead of recording success.

- Preserve zero volume when creating audio players.

- Delete the unused predecessor to the UserSettings API.

- Delete notification log entries by their unique ID without overwriting concurrent updates.

- Enable the badges API for plugins declaring profile badges.

- Propagate nested dependency failures and restart requirements before starting plugins.

- Handle queued task failures without unhandled promise rejections while continuing queued work.

- Require linked-message previews to match the requested message ID.

- Replace the hand-written attachment metadata base64 codec with browser primitives.

- Validate desktop favourite attachment downloads, reject redirects, cap downloads at 500 MiB and return safe errors.

- Apply the existing clip size limit to native file reads and reuse the byte-upload writer for selected clips.

- Remove unused icon viewer modal styles.

- Use the managed message hook for random mentions and choose members from the destination channel.

- Propagate folder-read and size-limit failures when automatically zipping dropped folders.

- Preserve incomplete automation log records until their remaining bytes arrive.

- Validate AI conversation entries before serialization and forward only their role and content.

- Delete unused automation cloning and linear-flow helpers.

- Use the existing validated data-path reader for automation templates and AI inputs.

## 2.2.0.0 - 2026-09-06

### Added

- Trigger workflows on presence, typing, channel selection, user updates, member updates, and relationship changes. Wait for those events inside a workflow, with user filters and separate timeout routes.
- Read current user presence, server membership, and the open channel directly from Discord stores.
- Show typed output fields, descriptions, and copyable references in the block inspector and saved-value picker. User lookups include display names, status, activities, and connected devices.
- Add user-presence and author-search templates.

### Fixed

- Search messages by author in a server or DM, paginate up to the requested result count, exclude surrounding context messages, and stop fetching when cancelled.
- Index triggers by event, channel, and user. Group run history without copying earlier entries for each log.

## 2.1.1.0 - 2026-09-05

### Fixed

- Reduce notification updates, timezone formatting work, visibility observer churn and repeated badge rendering work.
- Cancel obsolete plugin requests, presence updates, theme loads and native CSS watchers while preserving independent Discord windows.
- Share media loading, update sticker metadata atomically, cache ListenBrainz metadata and extract ZIP preview files only when opened.
- Remove unused browser editor bundles and cancel settings pagination after leaving the page.
- Port the applicable ProtonnCord nightly and PR #81 performance changes without the secure messaging extensions. Add regression checks for resource cleanup and output compatibility.

## 2.1.0.0 - 2026-09-05

### Added

- Automations can now react to this computer: triggers for joining or leaving a Roblox game (with the game's name, players, visits, icon and link, and how long you played), for a program starting or closing, and for Codex starting, finishing or asking a question.
- New block families: This computer (list running programs, is a program running, wait for a program, run a program, read a file, open a link), Roblox (current game, look up a game) and Codex (last result, recent sessions).
- Roblox game log and Codex finished templates.

### Changed

- Automations now default off. The master switch stops runs, queues, trigger listeners and computer polling while keeping the editor available.
- Computer events scan only the requested sources, with no permanent background timer.
- Add workflow migration, explicit data connections, reusable workflows, cancellable execution, calendar schedules and dry-run tests.

- Rebuild the Automations settings page as a spacious list with an on/off switch, plain-English "when it starts" text, template cards, and grouped run history and settings.
- Rebuild the automation builder: one toolbar, a single "What happens next" connections panel, beginner-first block settings with everything else folded under Advanced, a "+" on every output dot to add a connected block, hover-to-remove connection lines, wheel panning with Ctrl+wheel zoom, and grid snapping on release instead of during the drag.
- Auto-arrange now lays automations out left to right, with the Yes branch above, the No branch below, and the error branch beneath that.

### Fixed

- Update the pinned fast-uri dependency to 3.1.6 to resolve the dependency audit failures.

## 2.0.1.0 - 2026-08-29

### Fixed

- Restore Discord's original app archive when an interrupted update leaves only the LawyerCord patch marker, so Install, Reinstall / Repair, and Uninstall work again.

## 2.0.0.0 - 2026-08-29

### Fixed

- Make Stable, Beta, and Nightly updates fall back to the newest eligible release instead of reporting an older channel build as current.
- Show the installed LawyerCord version in Updater settings.
- Stop advertising Favorites editing because Discord enforces that permission server-side.

### Changed

- Advance Beta and Nightly source-update branches only from successful eligible releases.
- Replace stale Dependabot pull requests with pinned GitHub Actions updates and remove the Dependabot schedule.

## 1.17.0.0 - 2026-08-29

### Added

- Add Lawyers Fake Nitro, a targeted override for high-quality streaming and Favorites editing that does not change emoji, sticker, or theme access.

## 1.16.2.0 - 2026-07-30

### Fixed

- Repair folder-style patched Discord installations before installing LawyerCord.

## 1.16.1.0 - 2026-07-29

### Fixed

- Publish the standalone updater asset as `desktop.asar` alongside the LawyerCord-named copy.
- Defer Ghosted's private-settings restore until startup so LawyerCord loads correctly.

## 1.16.0.0 - 2026-07-29

### Added

- Automated nightly, beta, and stable release channels driven by protected pull-request merges.
- Release ZIP checksums and artifact auditing for Discord credential patterns and private runtime data.
- Windows graphical and command-line installer executables for nightly, beta, and stable releases.
- Discord-style local control panel with scrollable server lists, real runtime status, scoped message search, date-range message exports, and expandable privacy activity.
- Bulk channel selection controls for local indexing and message exports.
- Stable, beta, and nightly channel selection for standalone LawyerCord updates.

### Changed

- New installations begin with no channels approved for local semantic indexing.
- Live Discord MCP verification accepts authorized target IDs only through local environment variables.
- Message search now means local hybrid search across only channels explicitly selected in the panel; it does not search every Discord channel or DM.
- Removed the separate index-channel and security tabs. Protocol migration remains a visible runtime warning rather than a standalone settings page.
- Discord MCP message responses now retain Components v2 payloads.

### Security

- Release artifacts cannot contain local Discord MCP/control-panel configuration, bridge secrets, queues, ledgers, indexes, downloads, or Discord token-shaped values.
- The optional MCP remains unrestricted within its fixed tool surface but uses only the enabling installation's current Discord session and locally generated bridge secret.
- Release installers are built from a pinned, hash-verified Equilotl revision, embed the exact LawyerCord client payload, and do not download or self-update executable code.

### Planned

- An audited SecureMessaging protocol v2 after the provider, licensing, packaging, and migration gate is approved.
- Signed installable artifacts and platform-specific release verification.

## 1.14.16.0 - 2026-07-28

### Added

- LawyerCord product identity, browser metadata, local icon, and application-data namespace.
- App-lifetime loopback control panel with account, guild, relationship, plugin, storage, and network statistics.
- Encrypted local approved-channel search and tamper-evident evidence exports.
- Generated privacy inventory covering plugin domains, storage, and elevated capabilities.
- Scoped live Discord MCP verification harness.
- Security, privacy, contribution, CI, dependency review, CodeQL, audit, and controlled release documentation.

### Security

- Audited the ProtonnCord fork delta and documented remaining trust boundaries.
- Disabled source auto-update and cloud sync by default.
- Removed mutable remote installer execution and inherited upstream publishing workflows.
- Updated production and development dependencies until the full audit reported no known vulnerabilities.
- Replaced the obsolete `zip-local` build wrapper with the current JSZip API so extension packaging no longer depends on vulnerable JSZip 2 behavior.
- Retained the intentionally unrestricted Discord MCP with its fixed tool surface, authenticated local queue, attachment validation, mention suppression, and sent-message-only deletion ledger.

### Changed

- Renamed product-facing ProtonnCord identifiers to LawyerCord while preserving attribution and cryptographic protocol compatibility identifiers.
