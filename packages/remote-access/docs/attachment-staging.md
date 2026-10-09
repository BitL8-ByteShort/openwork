# Attachment staging foundation

This is an unfinished, capability-gated transport slice. The production native
adapter does not yet advertise `attachments`; these routes reject requests until
both the capability and native adapter methods are available. Existing phone
grants do not change.

Uploads use server-generated opaque IDs and are bound to one paired device,
workspace and session. JSON responses contain metadata, progress and mutation
receipts, never staging paths or native file URIs. Allocation, commit and cancel
share the existing durable mutation ledger. Chunks are one MiB, except the last;
an exact offset/content retry succeeds and a conflicting overlap is refused.

Limits are 20 MiB per file, four files / 40 MiB per draft, and 100 MiB of reserved
bytes per device. A smaller native limit wins. Staging lives in the private state
directory, with private regular files, no symlink following and no hard links.
Commit streams the checksum and checks declared MIME signatures before native
dispatch. Committing is persisted first. A lost upload reply or interrupted
commit remains uncertain and cannot be blindly retried with another UUID.

Cancel and expiry remove only staging files. They do not remove native inbox
results. Uncommitted uploads expire after 24 hours; cleanup currently runs on
authorized attachment traffic. Committed draft references remain reserved until
cancelled; prompt consumption is not implemented in this slice.

Still required before enabling this capability:

- Qualified native upload/materialization adapter and containment checks.
- Closed shared DTO schemas, prompt attachment IDs, model preflight and prompt
  deduplication with attachment consumption.
- Recovery after an unacknowledged partial chunk, active-transfer cancellation,
  and lifecycle cleanup independent of incoming requests.
- Native pickers, protected drafts, progress/retry UI and disclosure handling.
- Paired client qualification on both host platforms, followed by physical-device
  acceptance through the candidate TestFlight build.

The route tests use real private storage, authentication, Fastify and mutation
receipts. Only the native runtime boundary is synthetic. These tests do not
qualify a physical phone or a production native file upload.
