# Fork CI

The fork uses GitHub-hosted Ubuntu and macOS runners because it has no
Blacksmith runners. Upstream keeps its existing runner choices. The desktop
bootstrap still runs on Ubuntu 22.04; browser proof uses Ubuntu 24.04 and the
existing explicit browser/virtual-display setup. Test failures remain failures.

Remote access has a separate Node 24 macOS/Linux compatibility lane with no
model key, signing credential or live user data. It checks bridge types, build,
behavior and the desktop lifecycle tests. These automated checks do not replace
live host or physical iPhone qualification.

Upstream's hosted Evidence preview publisher is unavailable in this fork: its
blob storage and review service are not configured. Proof artifacts remain
available in Actions; the fork does not create a pending hosted-publication
check. The enterprise upgrade-baseline job is upstream-only because the fork
does not publish the corresponding enterprise release artifacts.

Warden remains enabled. It requires the `WARDEN_OPENAI_API_KEY` Actions secret;
without that credential, its failed review is unresolved. No API key is included
in the repository and no successful security review is inferred from the other
tests.
