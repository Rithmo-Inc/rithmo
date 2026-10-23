# Changelog

This project ships source releases on GitHub. The package remains `private: true`; releases do not
publish a package to npm. Entries describe the public repository's shipped behavior.

## Unreleased

No additional changes recorded yet.

## 0.2.0 — 2026-10-19

### Terminal policy and document controls

Meridian's policy decisions and the document employees read can now move at different speeds,
under terminal controls that run locally without credentials or a model provider.

- `--policy-every=N|never` sets the interval between support-policy changes. The default is
  **20 business days**. Changes cycle through data-export approval and three first-response targets.
- `--doc-delay=1..60|random|never` sets when new decisions reach the local policy document. The
  default is **3 business days**; `random` is reproducible and draws from 1–20 business days.
- Run length, policy interval, and publication delay are independent. The terminal reports both
  the operative version and the version in the published local document.
- Decisions use the existing charter, Controller, and append-only ledger. Admitted changes produce
  complete, immutable document revisions; rejected acts stay recorded and do not change the policy.
- The readable document is stored in `var/company-policy-document.json`. Its revision history,
  pending publication schedule, and settings history are stored separately under `var/`.

For a new company, this example ends on business day 52 with policy **1.2** and document **1.1**:

```sh
npm run company -- --days=52 --fresh --seed=7 --start=2026-10-01 --policy-every=25 --doc-delay=10
```

Decisions occur on days 25 and 50; document updates are due on days 35 and 60. `--fresh` archives
any existing company state before starting this example.

### Continuation and existing companies

- Settings persist across runs. Changing them records the business day they take effect;
  existing decisions and scheduled publication dates are retained.
- Companies created by the earlier source snapshot adopt the controls from their current day.
  The upgrade does not replay past days or invent policy changes for them.
- Interrupted policy admission and publication resume the recorded decision. A started policy
  day retains its original settings, even when the next command supplies different ones.
- `--fresh` archives company and policy state together. Invalid options fail before state changes;
  locked histories and an interrupted archive stop further runs until the recorded problem is
  resolved. Malformed state is not silently reset.

### Compatibility and current limits

- Node 24 or newer remains sufficient; there are no dependencies to install or build step.
- Existing SLA function signatures retain their original defaults. Callers opting into changing
  rules must select the policy operative at a request's arrival and pass those rules to the
  rule-aware SLA functions. Legacy queue callers do not automatically adopt revised targets.
- The CLI supplies no support processor. Customer requests remain open until a caller supplies
  one through the existing optional callback.
- Document publication is local JSON. This release includes no model-provider clients, live
  connectors, framework adapters, or MCP endpoint.
- The company uses its existing fixed `-0700` clock, weekdays, and no holiday model. Policy history
  begins on September 14, 2026; earlier start dates advance without an operative policy until then.

## 0.1.0 — initial source snapshot

The initial public snapshot included the synthetic CRM and roster, deterministic company runner,
authority and admission rules, durable ledger and company state, historical views, baseline SLA
calculations, and a model interface with a scripted test client. `0.1.0` was the package version;
there was no corresponding GitHub tag or release.

## Maintaining releases

For each source release, keep the package version, README status and runnable examples, and dated
changelog entry together in the release change. Record unreleased work here as it lands. Run
`npm test`, and verify the documented company commands in an isolated checkout with temporary
company state before publishing the matching GitHub tag and release notes. Preserve existing
company histories during verification. Keep `private: true` for this GitHub source-release
workflow.
