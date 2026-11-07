# Asistente cloud executor

This is a separate controller for the existing Asistente application. It does not
extend the static pilot or use its encrypted state branch as a new credit ledger.
The controller reuses Asistente's PostgreSQL queue and the credit ledger shared
with Office. It never initializes or refreshes a credit grant.

The workflow is inert unless repository variable `ASISTENTE_CLOUD_ENABLED` is
exactly `true` on `main`. Scheduled jobs use standard public-repository runners,
an immutable reviewed controller commit, a pinned container image, and at most
one invocation at a time. It is not a continuously running server or an uptime
guarantee. GitHub may delay or disable schedules.

Required private GitHub Actions secrets, pending explicit destination approval:

- `ASISTENTE_DATABASE_URL`: existing database access, with verified TLS.
- `ASISTENTE_OPENAI_API_KEY`: existing credit-backed key, no new billing.
- `ASISTENTE_GITHUB_TOKEN`: existing token restricted to blackops-reminder.
- `ASISTENTE_OPERATOR_JSON`: reviewed owner/order/workflow configuration.
- `ASISTENTE_CREDIT_JSON`: exact existing grant and pricing configuration.

Database access is a new trust boundary. The current connection may have broader
permissions than the factory tables. Do not represent application-level owner
checks as database credential isolation, or copy credentials before approval.
Prefer a restricted role when its operations can be verified against the shared
store without changing other consumers.

The host prepares dependencies before exposing secrets, with install scripts
disabled. Secret files live outside checkout under `RUNNER_TEMP`, mode 0600 in
a private directory. Only the pinned trusted controller receives them. Generated
candidate code still runs in the separate credentialless candidate workflow.
No pull-request event can run the production controller.

The bounded CLI allows up to four stages and thirty minutes; it stops admission
unless a full lease plus settlement window remains. Cancellation or lost results
do not authorize replay or reset costs. Uncertain work requires reconciliation.

Cutover must verify an actual remote invocation and the unchanged queue/receipts
before disabling the Windows factory task. Do not stop or modify the Office task
or Kong. Retire the old static-pilot schedule separately; preserve its history.

Publication and rollback remain disabled. Replit's documented MCP publish tool
publishes the workspace's latest contents, without a revision/CAS/rollback input.
Moving this executor alone does not prove autonomous software release.

Sources: https://docs.github.com/en/actions/concepts/billing-and-usage,
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule,
https://docs.replit.com/platforms/mcp-server.
