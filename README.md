# software-factory-pilot
Independent static software-factory pilot. No production data or Kong access.

This first deployment provides a fixed static baseline, hourly public health checks,
automatic republication of that baseline when verification fails, and a manually
invoked rehearsal that publishes a visibly different version and restores the
baseline. Public verification checks the manifest and SHA-256 of both site files.

It does not yet generate software with AI, process a factory queue, or activate
the eight-stage factory in blackops-reminder. No OpenAI credential is installed.

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
