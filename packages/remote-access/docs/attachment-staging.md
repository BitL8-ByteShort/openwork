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

Mac and actual NUC each passed 115 package tests, typecheck and build with
identical production-source hashes. Real scoped requests to the native adapter
materialized two files in one disposable prompt on each host; same-UUID replay
produced no second user prompt. Comparable chats, models, defaults, permissions,
workspace entries and existing pairing/ledger state were preserved. These
requests used Fastify injection, not a physical phone or a new TLS client test.

Still required: native pickers, protected phone drafts/bytes, progress/retry UI,
photo conversion policy and tests, paired-client qualification on both hosts,
and physical acceptance through the next TestFlight candidate. Production
capability advertisement and preview replacement wait for that client slice.

## Bounded history and phone foundation

The native history endpoint embeds base64 file contents. A dedicated streaming
projection skips only native message `files[].data` string values and emits safe
filename labels. Normal projected JSON remains limited to 8 MiB; native history
wire is capped at 64 MiB. A read-only one-message fallback retains the cursor
when a larger page exceeds that limit. This does not expand generic JSON limits
or expose native URIs or file bytes to the phone.

Nine regression cases cover large files, attachment-only messages, unrelated
large metadata, malformed JSON/UTF-8 and bounded fallback. Mac and actual NUC
passed 115 tests/22 files, typecheck and build with identical production source.
Read-only native history checks on both hosts returned PNG/PDF labels in 1,853
bytes. Accepted upload/prompt evidence was reused; no new inference was needed.

## Qualified client and capability continuation

The independently maintained iOS candidate now implements protected drafts,
photo conversion, native picker entry points and upload/recovery controls.
One native Simulator prompt containing a photo and PDF passed through paired
HTTPS on each actual host; selected-file input was injected into production
importers. The model read both contents, temporary credentials and mappings
were cleaned up, and existing host state/pairing was preserved. This is not
physical picker or cellular acceptance.

Desktop embedding explicitly qualifies attachment availability after compatible
health. External adapters default to unavailable; read-only and incompatible
adapters cannot advertise it. A later incompatible health check withdraws it.
The existing registry feature `remoteAccess` remains off by default on cloud and
self-hosted deployments; its kill switch closes the bridge and drains scoped
work. This qualified subset does not create a second rollout or environment
flag. The separate host-owned `fileTransfer` grant remains default-off and is
checked on every scoped transfer. No existing phone grant is expanded.

Five advertisement regressions pass; both actual hosts passed 120 package
tests/23 files, typecheck and build with identical production sources. Physical
selection/recovery and the next signed TestFlight candidate remain release
gates. Client behavior and data handling are recorded in the iOS repository's
`docs/ATTACHMENTS.md`.
