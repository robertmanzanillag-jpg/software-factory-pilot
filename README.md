# software-factory-pilot
Independent static software-factory pilot. No production data or Kong access.

This first deployment provides a fixed static baseline, hourly public health checks,
automatic republication of that baseline when verification fails, and a manually
invoked rehearsal that publishes a visibly different version and restores the
baseline. Public verification checks the manifest and SHA-256 of both site files.

It does not yet generate software with AI, process a factory queue, or activate
the eight-stage factory in blackops-reminder. An operator-authorized OpenAI key
is configured as a repository secret; the publication workflow never reads it.

Only standard public GitHub runners and GitHub Pages are used. Artifacts are tiny
and retained for one day. No external hosting, databases, payment setup or recharge
is configured. GitHub schedules can be delayed and can be disabled after 60 days
without repository activity; this is periodic recovery, not an uptime guarantee.

Local check: `node --test tests/site.test.mjs`.
Manual recovery/rehearsal: run **Pilot publication and recovery** from Actions;
check the rehearsal option to publish and restore the alternate version.
The workflow summary records verified content identities. Check the restoration
step before treating a rehearsal as successful. Cancellation or platform outage
can interrupt recovery; a subsequent hourly check attempts baseline restoration.

All source changes should use a reviewed PR. Publishing is restricted to this
repository's main branch. The workflow cannot publish to Kong or other repositories.

The manually invoked **Verify factory connection** workflow tests encrypted
GitHub state and a single bounded Responses request. It does not enable an AI
schedule. The diagnostic model/prices expire November 7, 2026 UTC and are not
a production model selection. Each request reserves one cent persistently before
generation; unknown outcomes block later requests. At most 64 diagnostic requests
can be admitted in this dedicated probe history, which is separate from the
future production ledger. Include those costs when initializing production.

The storage encryption key is derived from the authorized API key using HKDF
with a separate application context. Rotating that key requires an explicit state
migration using the old key; never reset the ledger when decryption fails.
Generated provider modules originate from the reviewed factory TypeScript
implementation in blackops-reminder, not from model-generated code.
