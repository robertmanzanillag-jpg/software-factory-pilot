# Software factory pilot

An independent public static pilot, isolated from Kong and production data.

The trusted worker stores its queue, leases, review evidence and financial ledger
as authenticated encrypted data on the dedicated `factory-state` branch. API
calls reserve their maximum cost before generation; uncertain outcomes retain
that reservation and stop admission. Restarting a workflow does not reset costs.

The activation path runs the real discover/build/browser/review/deploy/verify/
rollback/evaluate chain. Three complete staging cycles, each with exact-version
review and verified restoration, are required before automatic production
release. Candidate commands run in isolated containers without credentials or
external network access. Only bounded text edits inside existing `site/index.html`
markup can qualify for automatic release. Tags, attributes, scripts, dependencies,
permissions and factory controls are outside that scope.

After activation, the hourly worker checks the latest deployed version and
processes owner-created open issues labelled `factory-approved`. Tasks are admitted
once across revisions; bounded repair attempts belong to their existing pipeline.
Other repositories and Kong are not eligible. No arbitrary server applications or
databases are hosted here. Learning proposals are not promoted without real
historical and held-out evaluations; none are currently configured.

The initial credit allowance is deliberately limited to $1, including the prior
connection diagnostic. New work pauses at 95 cents to retain recovery headroom,
and on November 20, 2026 UTC, when the current credit checkpoint expires. No payment
method, recharge or paid hosting is configured by this repository. A fresh credit
and pricing check is required before extending that checkpoint. This is a local
admission limit, not a change to the OpenAI account's billing settings.

OpenAI model snapshot `gpt-4.1-mini-2025-04-14` uses verified rates of $0.40 input
and $1.60 output per million tokens through this checkpoint. It remains available
until January 14, 2027 according to the official deprecation schedule; migration
must be reviewed before then. The model is used only for this narrow static pilot.

Publication uses a separate workflow that rechecks the active ledger job, lease,
fence, exact predecessor and release gate before touching Pages. Staging lives
under `/staging/`; restoration uses immutable baseline files. Production advances
main only without force. Recovery creates a commit with the exact baseline tree,
also without forcing over unrelated concurrent changes. The former baseline-only
hourly publisher is removed so it cannot overwrite current releases.

GitHub Actions schedules may be delayed or disabled by the platform. This is
scheduled autonomous operation, not a continuously running server or an uptime
SLA. Unknown execution outcomes stop the queue for reconciliation; they are not
reported as successful recovery. The manual `activate` command initializes the
ledger and starts the activation chain; `run` resumes admitted work and `status`
reports accounting without enabling work.

Validation: `node --test tests/*.test.mjs`. The `candidate.yml` workflow performs
actual baseline/candidate Chromium checks at mobile and desktop sizes. Generated
`factory-core.mjs` is bundled from the reviewed TypeScript implementation in
`blackops-reminder`; regenerate it when that source changes. API keys are repository
secrets and are never part of this code. Rotating the key requires migration of
encrypted state using the old key; decryption failure must never reset the ledger.

Sources:
- https://developers.openai.com/api/docs/models/gpt-4.1-mini
- https://developers.openai.com/api/docs/deprecations
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
