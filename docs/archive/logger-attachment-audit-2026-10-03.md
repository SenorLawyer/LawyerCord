# Message logger attachment audit

The 4.1.2.0 Nightly candidate fixes attachment work that delayed durable message logging and accumulated across deletion events. With attachment saving enabled, the previous source admitted 16 physical downloads from 16 ordinary deletion events and produced listener warnings. Bulk deletion is a separate path and does not schedule attachment work.

Messages and pending attachment IDs now commit together in the existing version-1 database record. A renderer processes one compact job at a time. Native admission permits four physical transfers across senders, including transfers still closing responses or removing temporary files. Matching senders share a transfer but can cancel independently. These bounds constrain resource use; they are not measured optimal throughput settings.

Completion rereads the record in a transaction and checks account, revision and pending attachment membership. Deleting, clearing, retaining fewer logs, replacing a message or switching accounts cannot let a stale result recreate or overwrite a record. Interrupted work resumes for its original account. Cache-folder changes retry after cleanup. Exported logs omit internal work metadata, and imports do not create jobs.

## Evidence

- `pnpm testPerformance`: 1,329 checks passed with real FFmpeg and no skipped checks. The suite includes actual-source native admission, response/file cleanup, cancellation, URL fallback and renderer-to-native payload tests.
- `scripts/testLoggerAttachmentBacklog.ts`: stalled downloads leave all 16 messages durable; account A/B/A, deletion, replacement, imports, cache updates and rejected cancellation recovery are covered. A 10,000-record history is traversed in bounded pages once. Later isolated older admissions read the affected row twice without traversing newer history again.
- An isolated Chromium 151 profile ran the actual bundled `db.ts` and `idb` library against real IndexedDB. It verified version-1 reopening, durable work after page reload, account filtering, deletion/revision guards, aborted completion and successful completion. Recovery over 10,000 synthetic records with 25 pending jobs used 126 page calls and took 401 ms on the test machine. This is a database recovery measurement, not a Discord FPS benchmark.
- An older version-1 connection could read the new records. Its legacy overwrite discarded the optional pending-work field as expected. Rollback preserves log readability but cannot preserve download intent when an older client rewrites that record.

## Limits

Startup recovery still visits existing records once because the database schema has no pending-work index. Pages contain at most 100 scanned records and recovery yields between pages. Bursts of newly admitted old messages may visit the range between their IDs. Historical and imported records are not assigned an inferred account or scheduled for download. Conclusive transfer failures complete their pending attempt; this is not a permanent retry service. Existing saved-file retention behavior is unchanged.

Live Discord frame times, heap growth and the complete enabled-plugin combination remain unmeasured. These tests establish the specific bounded-work and persistence fixes, not resolution of every long-session performance problem.
