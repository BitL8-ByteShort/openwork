# Scoped generated files

The embedded adapter advertises `artifacts` only after explicit qualification
and compatible native health. This read-only capability is independent of
prompt-write availability. Older embeddings default to false; an incompatible
health check withdraws support. The existing `remoteAccess` policy/kill switch
still controls the whole bridge. File transfer also requires a computer-approved
device grant, which is never expanded automatically.

The bridge exposes only:

- `GET /v1/workspaces/:wid/sessions/:sid/artifacts`
- `GET /v1/workspaces/:wid/sessions/:sid/artifacts/:id/content?revision=…`

The catalog uses the native workspace registry and workspace-scoped session
proxy to establish the persistent workspace and execution directory. Completed
tool output manifests/write metadata and explicit assistant outbox links are
untrusted candidates. They do not bypass file ownership, containment, type or
size validation. There is no phone-supplied path, general workspace file list,
raw native outbox proxy, shell endpoint or external URL fetch.

Execution outside the workspace is permitted only for a registered Git
worktree with the same canonical Git common directory. Fixed read-only Git argv
verifies this association; no transcript-derived command runs. Files must be
owned, regular, singly linked and non-executable. Descendant symlinks are
rejected; open descriptors use `O_NOFOLLOW`. Root, path and file metadata are
rechecked during hashing and transfer. These checks do not create an atomic
filesystem snapshot against a hostile process with the same OS user.

Opaque handles bind device, workspace, chat and the file revision. They expire
after 15 minutes. The catalog is bounded to 100 files and a 100 MiB hash budget;
larger result sets explicitly continue on the computer. Each file is at most
20 MiB and has a complete SHA-256. Supported types are UTF-8 text, PNG/JPEG, PDF
and share-only RTF. Archives, executable/active HTML/SVG, unqualified MIME
signatures and external URLs are excluded. Native model generation can still
produce a damaged file; clients must validate their preview inputs separately.

Content routes refresh native association and file revision before reading.
Explicit single byte ranges are bounded to 1 MiB; open/suffix/multiple ranges
are rejected. Full transfers remain bounded to 20 MiB. Responses include exact
length, type, checksum ETag, attachment disposition and no-store/nosniff headers.
Two transfers per device/eight globally, scoped cancellation and a 120-second
lease bound resource use. Client disconnect, grant revocation and shutdown
close the scoped read; each stream chunk rechecks authorization and metadata.

Mac and actual Ubuntu NUC checks passed 149 tests, typechecking and bundle/
declaration builds with identical production sources. Native paired HTTPS
Simulator flows verified text/PDF results, stale revision refusal, damaged PNG
rejection and explicit original-file sharing to an isolated test destination.
Valid PNG tests repaired only disposable synthetic outputs and restored them;
they do not qualify the model's original PNG generation. Registered worktree
containment has real filesystem tests on both hosts. A complete live engine
result generated in a session worktree and physical iOS sharing remain separate
acceptance gates. No signed packaged host distribution is implied.
