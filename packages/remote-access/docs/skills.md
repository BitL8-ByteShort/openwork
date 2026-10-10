# Workspace skills

Qualified computers expose a scoped catalog, detail, save and delete operation
under `/v1/workspaces/:wid/skills`. `skillsRead`, `skillsWrite` and `skillsSelect`
are independent optional capabilities. Older computers do not advertise them.
Reads require current project access; editing also requires the phone's explicit
workspace-administration grant and the native server's write approval.

Only flat workspace-owned `.opencode/skills/<name>/SKILL.md` text entries are
editable. Inherited entries, managed/account entries, symlinks and directories
with extra assets are protected. Managed engine metadata can be selected, but
its instructions remain on the computer. Opaque IDs are bound to the workspace;
phone responses contain no native filesystem path or provider credential.

Text is bounded to 64 KiB. The existing 40 KiB encoded JSON request limit also
applies; escaping and metadata reduce the amount that fits in a phone save.
Names use native kebab-case validation and skills retain required name and
description frontmatter. Native formatting is authoritative.

The native conditional extension serializes legacy and conditional skill writers
in the same server process. A file revision includes canonical path, inode/time
metadata and bytes. Stale edits and deletion reject; new entries cannot replace
an existing filename or inherited name. A complete temporary file is synced
before replacement, and conditional deletion removes only the text file and its
empty directory. External editors do not acquire this process lock: the last
revision check detects intervening changes, but this is not a filesystem
transaction against a hostile same-user writer racing the final rename.

Save/delete remain subject to the existing native approval queue. Waiting for
approval is not installation. Denial and known stale validation are safe
rejections; timeouts, revoked access after dispatch and lost readback are
unconfirmed. A durable UUID receipt forwards at most once. A save receipt also
binds `resourceRevision`, so a later desktop edit cannot confirm the phone's
earlier saved version.

Selected opaque IDs are resolved through exact engine ID/file bindings, including
duplicate-name handling. Each send calls the native session permission endpoint
with the actual skill resources before dispatching native `skills` in the prompt.
No saved permission rule, approval reply, prompt-prose substitution or forced
Always allow is used. Native ask/deny hands off to the computer without sending
the prompt. This applies to text and attachment sends.

Mac and Ubuntu NUC source previews have passed bridge/native automated checks,
paired HTTPS create/update, stale rejection, receipt replay and selected prompts
under their existing native policy. Isolated native manual-queue tests on both
hosts proved that queued/denied writes do not install a skill. Synthetic native
iOS tests cover ask handoff, kept drafts, managed entries and local dismissal.
Physical iPhone/iPad and the full release candidate remain separate gates.
Internal TestFlight build 5 excludes this slice.

Both paired native Simulator flows edited, read back, selected and explicitly removed the disposable skill. The NUC flow also exercised scrolling its larger catalog. Source previews reopened with private backups and all existing comparable host state and phone grants preserved.

![Native managed-skill detail using synthetic content](images/skills-managed.png)
