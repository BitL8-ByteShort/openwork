# Attachment transport and prompt binding

This capability remains unavailable in production until the native client and
paired qualification are complete. Existing phone grants stay unchanged. File
transfer requires a deliberate host-owned grant; legacy grants default off.

Uploads have server-generated opaque IDs bound to one device, workspace and
session. JSON contains metadata, progress and mutation receipts, never staging
paths or native URIs. GET session `/attachments/limits` reports the effective
file cap and current model's supported input MIME list. Allocation, commit and
cancel use stable request UUIDs. PUT chunks are one MiB except the final chunk;
exact content/offset retries succeed and conflicting overlaps fail.

Product limits are 20 MiB/file, four files and 40 MiB/prompt, and 100 MiB of
reserved bytes/device. A smaller native cap wins. Private staging files use
0700 directories and 0600 regular files, without final-component symlink or hard
link following. Commit verifies length, streamed SHA-256 and MIME signatures.
These signatures are not full media-decoder validation.

The adapter reads native session/model/inbox capabilities before dispatch. PNG
and PDF materialization was measured on both macOS and Ubuntu NUC with
`opencode/muse-spark-1.3-contributor-free`. Other models' advertised inputs are
catalog preflight metadata, not a claim of live qualification. JPEG is not yet
advertised by this native adapter. The native engine has no model conditional
write, so a later computer-side model change can race preflight.

Native upload streams from the already-open staging file. Its inbox filenames
are generated from the attachment/session IDs. Known symlinks and containment
changes are rejected before/after dispatch, and returned bytes are verified.
These checks do not make the legacy native path writer atomic against a hostile
process running as the same OS user.

Prompts accept `attachmentIds`, never phone-selected paths or URIs. All IDs are
claimed together for one stable send UUID before inference. The native message
ID is derived from device identity and that UUID. Competing sends cannot consume
an ID twice. Accepted sends release draft reservations while retaining host
files. Lost admission replies or restarts retain an uncertain intent and cannot
be repeated automatically with another UUID.

Native upload is also marked durably before forwarding. A lost/malformed reply
stays uncertain. Cancellation aborts an active upload and removes only staging;
it cannot promise to undo an already-dispatched native write. Unacknowledged
partial chunk tails can be discarded only after the saved prefix is verified.
Uncommitted staging expires after 24 hours, checked at server startup, every
minute and on transfer traffic. Old allocation-orphan files in the generated
staging namespace are cleaned without following symlinks. Shutdown cancels and
drains operations before the state store closes. Native committed inbox files
are never deleted by staging cleanup.

Mac and actual NUC each passed 106 package tests, typecheck and build with
identical production-source hashes. Real scoped requests to the native adapter
materialized two files in one disposable prompt on each host; same-UUID replay
produced no second user prompt. Comparable chats, models, defaults, permissions,
workspace entries and existing pairing/ledger state were preserved. These
requests used Fastify injection, not a physical phone or a new TLS client test.

Still required: native pickers, protected phone drafts/bytes, progress/retry UI,
photo conversion policy and tests, paired-client qualification on both hosts,
and physical acceptance through the next TestFlight candidate. Production
capability advertisement and preview replacement wait for that client slice.
