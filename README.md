# Rithmo

A deterministic synthetic enterprise for **AI agent reliability** and **AI agent governance**
testing against business context that changes over time.

Rithmo ships a fictional company — **Meridian Works**, which sells scheduling and dispatch software
to construction, facilities, trucking and field-service businesses — with a CRM, a staff roster, a
support inbox, an authority model, and an append-only record of everything anyone has decided. You
can run the company forward, ask it what was true at any point since the run began, and test whether
an AI agent acts on **current, resolved business context** instead of stale, conflicting, or
superseded information.

The commercial Rithmo product is the **fact-checker for AI agents**. This repository is the open
evaluation environment for testing that class of reliability and governance failure against known
truth.

**Every person, company, email address, domain, deal and dollar figure in this repository is
synthetic.** Nothing here describes a real organization or a real individual.

## Why this exists

Agents that work inside companies get things wrong for a reason that has little to do with
reasoning ability: **the truth moved.** A discount was approved and then superseded. A deal moved
to a new stage after the agent read the CRM. A product incident was fixed, so "that capability is
broken" stopped being the right answer. A policy answer that was correct in March is wrong in
June. The agent retrieves something true-sounding, and ships it after it stopped being true.

That failure is hard to test against production systems, because you cannot replay a real company
and you rarely have a trustworthy record of what was knowable at the moment an answer was given.

This repository gives you one that is fully determined:

- **Authority is structural.** Who may decide what is a predicate over a declared charter, not a
  judgement call. An act outside someone's authority is rejected with a reason, not scored.
- **Truth is derived, never authored.** Operative state is `fold(charter, admitted acts ≤ T)`.
  Nothing writes "the current answer" directly.
- **Supersession is first-class.** A later admitted decision displaces an earlier one, and both
  remain in the record with the instant each took effect.
- **Reconstruction replays the real transition functions.** Asking "what was true at 11:04 on day
  six" runs the same code paths as the original writes, so an as-of view cannot drift from the live
  one by construction. The window is the run: the company starts from a fixed snapshot that has no
  history of its own, so reconstruction covers any instant **since the run began**, not earlier.
- **Runs are reproducible.** One seed, a synthetic business-day clock, no wall-clock reads in the
  state machinery. The same inputs produce the same company, every time.

So you can construct the exact situation you want to test — a superseded approval, a deal stage
that has since moved, a support reply that was correct an hour earlier — and know precisely what the right
answer was. That makes the repository useful for testing managed agents, autonomous agents, and
multi-agent workflows that need reliable, auditable decisions over changing enterprise context,
with provenance and an audit trail.

## Run it

Requires **Node 24 or newer**. Node runs the TypeScript sources directly, so there is **no install
step and no build step**.

```sh
git clone https://github.com/Rithmo-Inc/rithmo.git
cd rithmo
npm test                        # 147 tests: 145 passing, 2 skipped
npm run company -- --days=30    # run Meridian forward 30 business days
```

The two skips are reconciliation tests that compare a live company against its own ledger; a fresh
clone has not run the company yet, so they report *skipped* rather than quietly passing with nothing
to check.

`npm run company` writes the company's state under `var/` and the next invocation continues from
there, so `--days=1` thirty times and `--days=30` once produce the identical company. To start a new
one, `--fresh` moves the existing state into `var/archive/` and tells you where — nothing is ever
deleted. `--seed=<n>` and `--start=<YYYY-MM-DD>` apply when a company is being initialised.

There are no dependencies to install. `npm install` is not required and there is no lockfile —
`node --test` is the whole toolchain.

## What is included

| | |
|---|---|
| **Declared organizational truth** | Roles, authority scopes, a discount ceiling, pipeline stages, support categories and severities — as predicates the controller enforces, not documentation. |
| **Deterministic controller and ledger** | Every act is admitted or rejected with a verdict and a reason, then appended to an immutable log. Replaying the log reproduces the state exactly. |
| **Synthetic time** | A seeded business-day clock and intraday planner. No weekends, no wall-clock reads, no holiday model. |
| **Durable company state** | Checkpointed CRM and support state with refused schema versions, in-memory forward migration, and atomic temp-and-rename writes. |
| **Historical reconstruction** | As-of views of any deal, account or support request at any point since the run began, plus a first-response SLA read-model over them. |
| **A synthetic CRM dataset** | 223 companies, 600 contacts, 470 deals, 3,343 activities and a 32-person roster, in `seed/hubspot-manifest.json`. |
| **A deterministic runner** | `npm run company` advances the company one business day at a time: opportunities open, deals move and close, renewals come due on schedule, customers write in, product capabilities break and get fixed, accounts go on a risk register. Seeded, offline, and reproducible. |
| **A model contract, with no provider** | Request/reply shapes, a `ModelClient` interface, and a scripted client for tests. Bring your own provider implementation; this repository contains no HTTP client, no API-key read and no network call. |

## Architecture

Three layers, with a dependency arrow that points one way. All three are enforced by
`tests/separation.test.ts` rather than described here and hoped for.

### Core — `src/controller/`, `src/charter/`, `src/actions/`, `src/logging/`, `src/employees/`

Authority, admission, the append-only ledger, the act vocabulary, transports, logging, and the
employee runtime. Core runs on its own: it imports nothing but itself and Node built-ins.

### World State — synthetic time, durable state, reconstruction

A seeded business-day clock and intraday planner, checkpointed CRM and support state, and as-of views
of any deal, account or request at any point since the run began. World State may read down into Core.
**Core may not read up into World State** — otherwise the guarantee that Core runs alone would quietly
stop being true.

### Living Company — the runner

What moves the company forward: the weighted event families, what each one does to the CRM, the
consequences that follow (an incident fixed, a renewal due, a risk call, a recovery plan), the state
those own, and four local transports that publish through Core's action client. Living Company may
read down into World State and Core; **neither may read up into it.**

Working a customer's support request is the one thing in this company that would need judgement
rather than a dice roll, so it is an *optional injected callback* that the runner never imports. The
CLI supplies none, which is why requests are recorded and stay open rather than being quietly
answered.

The boundary is machine-checked six ways: every import in each layer must resolve inside that
layer's own allowed set or to a `node:` built-in; no file may be declared in two layers; neither
lower layer may reach up; every `.ts` file present under `src/` must belong to exactly one declared
layer, so a file cannot be shipped unguarded; `scripts/` must resolve entirely inside the published
tree; and a set of controls drives the scanner against planted violations, so a broken scanner fails
loudly instead of passing everything.

The boundary tests verify the shipped source against the import patterns the scanner covers: literal
`import`/`export … from` specifiers at statement position, the `} from "x"` line that closes a
multi-line import, and literal `import("x")`. Within those forms a bare package import fails the
boundary, which is how the repository's zero third-party dependencies are enforced rather than merely
asserted. It is a pattern check over source text, not a resolver: an import written in an unusual form,
or a specifier computed at runtime, is outside what it inspects. `package.json` declares no
dependencies and there is no lockfile, so those are the two places to look if you want to confirm it
yourself.

## What is deliberately not included

Rithmo the company sells a commercial product that reads real enterprise evidence. **This repository
is not that product, and it is not an argument that the product is unnecessary.** It is the opposite
end of the problem: the commercial system has to *infer* organizational truth from messy real
evidence, and you cannot evaluate an inference engine without a world where the right answer is
already known. This repository is that world.

So the hard parts are not here:

- **Inference from arbitrary real evidence** — meetings, transcripts, threads, documents, tickets,
  and the systems they live in. Here, truth is declared and controlled.
- **Uncertainty resolution** — deciding what a decision *was* when the evidence is partial,
  contradictory, or never stated outright. Here, an act is structured and its verdict is a function.
- **Production integrations** — no connector, no OAuth, no provider client, no live transport. Only
  the authorization gates that a live transport would have to pass.
- **Governance and operations** — tenancy, access control, retention, audit, administration.

What generalizes from this repository is the evaluation substrate: deterministic state, structural
authority, supersession, and as-of reconstruction.

## A note on in-code provenance

Some comments explain *why* a rule is what it is by citing the Meridian Works source artifacts it
was derived from — a support policy, a product roadmap, an internal document ID like `MW-DOC-0011`.
Those citations are real: the company's rules were authored from a consistent body of synthetic
material rather than invented per-file, and the comments record which part of it a rule came from.

Not every one of those authoring artifacts is included in this minimal release, so a few references
point at material you cannot open here. They are kept rather than deleted because the reasoning they
record is the useful part, and a rule whose origin is stated is easier to trust — and to change —
than one that simply appears. Treat them as design notes, not as missing dependencies: no code in
this repository imports or requires anything that is not in this repository, and the boundary tests
prove it.

## Data and safety

Every email address and company domain in the shipped CRM uses the reserved `.invalid` top-level
domain (RFC 2606), which can never be registered and never resolves. Nothing in the dataset names a
real inbox or a real host.

That is enforced, not just stated. `tests/datasetSafety.test.ts` runs on every `npm test` and checks
all 632 address fields and all 223 company domains against an **anchored whole-field shape** — ASCII
labels, last label exactly `invalid` — so a field is accepted only when the entire value is what it
should be. Checking address-shaped *substrings* instead would not be enough: a value whose visible
prefix ends in `.invalid` can still carry a real domain after it. The manifest is also read *after*
JSON decoding, since a unicode-escaped `@` hides a routable address from any scan of the file's bytes
while every consumer that parses the file still receives it.

What that test does **not** claim, stated here rather than left to be discovered:

- It additionally rejects strings matching **a short, explicitly non-exhaustive list of 14 common
  registrable suffixes**, as a backstop for a bare domain sitting in prose where there is no `@` to
  anchor on. A domain under some other suffix passes that particular check.
- It speaks only for the manifest as shipped, and says nothing about data you generate afterwards.
- It is a property of the data, not a sandbox. It cannot stop code you write from reaching the network;
  it ensures this dataset gives it no real host to reach.

Each detector has a control beside it that plants a violation — the escape above, a quoted local part
hiding a real domain, a non-ASCII TLD, an IP-literal domain — and requires the detector to fire,
because a clean result from a broken detector is indistinguishable from a clean result from
clean data.

The company names, person names, cities and states are likewise synthetic. Some are plausible — that
is the point of a realistic evaluation world — but they do not correspond to real companies or
people.

No real credentials, tokens, or secrets are present. Nothing in `src/` reads an environment variable
or opens a network connection. The token-shaped strings you will find are the logger's redaction
patterns in `src/logging/logger.ts` and one obviously fake fixture in `tests/safety.test.ts` that
proves the redaction works — the guard, not the thing guarded.

## Status

Early. The surface above is tested and stable enough to build evaluations on, but this is version
0.1.0 and all three layers will grow. The company's people, products and documents are fixed today:
what evolves is its pipeline, its support inbox, its incidents, its renewals and its risk register.
Determinism and the layer boundary are the two properties intended to hold across changes; `daySeed`
in `src/living/worldClock.ts` carries an explicit compatibility contract for exactly that reason.

**Known limitation.** The Customer Success risk trigger is synthetic and has not yet been empirically
calibrated: it asks for repeated incident-caused tickets on a single account, which a 30-day run
rarely produces, so the risk register is usually empty over a short horizon. The runner states that
explicitly rather than printing a zero.

## Talk to the builders

- Website: [rithmo.ai](https://rithmo.ai)
- Email: [hello@rithmo.ai](mailto:hello@rithmo.ai)
- Book time: [Google Calendar](https://calendar.app.google/6zoprUWgJn1QDusf7)
- GitHub: [Open an issue](https://github.com/Rithmo-Inc/rithmo/issues/new)

## License

Apache-2.0. See [LICENSE](LICENSE).
