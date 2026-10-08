# EventWitness

A bounded, challengeable status feed for **one event**, built as a GenLayer
Intelligent Contract. Three registered sources on three different sites are
read independently by validators; the contract records whether the event is
`SCHEDULED`, `POSTPONED` or `CANCELLED`, keeps a history, and lets anyone
challenge a provisional decision once per round with one extra page.

No payments, refunds, bonds or token logic. Status: **review candidate**; ran on GenLayer Studio (two
rounds, see "Evidence"); conflict and challenge paths are tested only locally.

## Intended use

An event platform wants the cancellation/postponement status of a specific
concert to be derived from the organizer, the venue and the ticketing site,
with a visible, challengeable history, instead of trusting any single page.

## How a decision is made

1. The owner deploys with the event identity, its original date (`YYYY-MM-DD`),
   three source URLs and a challenge window (300 to 86400 s). The three URLs
   must be `https`, and must be on three different *sites* (see limitations).
2. `start_round()` then `assess()` (both owner-only). Every validator fetches
   each source itself and asks its model for a structured vote:
   `{"event_match": true, "status": ..., "quote": ...}`. A vote counts only if
   the event matches, the status is explicit, and the quote is **verbatim on the
   fetched page** (compared whitespace-normalised). Anything else is `UNKNOWN`;
   absence of evidence never means `CANCELLED`.
3. Votes reduce to one outcome per site, then across sites:
   - two or more sites agree and none contradicts: that status;
   - any two sites explicitly disagree (or one site contradicts itself): `CONFLICT`;
   - fewer than two sites state a status: `UNKNOWN`.
4. A status outcome becomes a **provisional** decision with a deadline of
   `now + window`. Anyone may `challenge(url, note)` before the deadline with one
   extra page from a configured host. It is accepted only if it changes the
   decision; otherwise the call reverts and the round's challenge is not used.
5. After the deadline anyone may `finalize()`. All sources are re-read; the
   round finalizes only if the new outcome equals the candidate. Otherwise the
   round returns to `NEEDS_EVIDENCE`.

`NEEDS_EVIDENCE` is recoverable: the owner can `add_source(url)` (up to 2 extra
pages on configured hosts) or `remove_source(url)`, then call `assess()` again in
the same round.

## Consensus design

`gl.vm.run_nondet(leader, validator)` with a custom validator. Only the **final
outcome** is persisted, so only the final outcome has to match: the validator
re-reads every source itself and accepts the leader if and only if its own
outcome is identical. Source-level `UNKNOWN`s may differ (leader
`[S, S, unknown]` and validator `[unknown, S, S]` both give `S`); a status that
changes the outcome, or an explicit contradiction, rejects the leader. The
contract does not claim agreement on any per-source reading, because none is
stored.

## Methods

| Method | Who | Notes |
|---|---|---|
| `__init__(event_identity, original_date, source_urls_json, challenge_window_seconds)` | deployer = owner | validates date, URLs, sites |
| `start_round()` | owner | from IDLE / FINALIZED / NEEDS_EVIDENCE; clears the challenge URL; max 20 rounds |
| `assess() -> str` | owner | from OPEN / NEEDS_EVIDENCE |
| `add_source(url)` / `remove_source(url)` | owner | only between assessments; base sources are immutable |
| `challenge(evidence_url, note) -> str` | anyone | PROVISIONAL, before deadline, once per round, must change the decision |
| `finalize() -> str` | anyone | after deadline; re-reads all sources |
| `get_state_json()`, `get_history_json(i)` | view | history rows record caller, timestamp, sources used |

## What changed after the first review

| Finding | Change | Test that fails without it |
|---|---|---|
| `NEEDS_EVIDENCE` accepted no evidence (dead end) | owner `add_source`, `assess()` allowed in `NEEDS_EVIDENCE` | `test_owner_can_add_evidence_and_reassess` |
| Any caller could append a permanent URL via `challenge` | challenge URL is round-scoped, cleared by `start_round()` | `test_a_challenge_url_cannot_poison_later_rounds` |
| Any caller could `assess()` and burn rounds | `assess`, `start_round`, source edits are owner-only | `test_owner_only_actions` |
| `json.dumps` escaped non-ASCII text, so verbatim quotes never matched | `ensure_ascii=False`, whitespace-normalised quote check | `test_non_ascii_page_text_reaches_the_model_unescaped`, `test_quote_matches_across_whitespace_differences` |
| `a.x.com`, `b.x.com`, `c.x.com` counted as three hosts | distinct *sites* (registrable-domain heuristic) | `test_same_site_does_not_count_as_independent` |
| `datetime.strptime` / `fromisoformat` not known to exist in GenVM | dates and the consensus timestamp are parsed by hand | `test_timestamp_parsing_variants`, `test_bad_dates_rejected` |

## Tests

`pip install genlayer-test` then `python -m pytest tests/direct -v` (in-memory,
mocked web and model). 89 tests pass; see `evidence/direct-tests.txt`. Each fix
above was also reverted on its own to confirm the suite fails
(`evidence/mutation-checks.txt`); one mutant survived the first 88 tests and led
to an extra test.

## Evidence

- Local direct-mode tests: 89 pass (above). They use mocked pages and a mocked
  model, so they check contract logic, not model behaviour or network consensus.
- **Live run on GenLayer Studio** (Normal / full-consensus mode, 2026-10-08), one
  contract instance, two complete rounds on the same input. Raw values are in
  `evidence/live-run-1.txt`.

| Item | Value |
|---|---|
| Contract (Studionet) | `0xD1c4378e3D278e33B49B670ECe629b0e4945D977` |
| Open in Studio | https://studio.genlayer.com/?import-contract=0xD1c4378e3D278e33B49B670ECe629b0e4945D977 |
| Explorer | https://explorer-studio.genlayer.com/address/0xD1c4378e3D278e33B49B670ECe629b0e4945D977 |
| Event | Tokyo 2020 Summer Olympics, original date 2020-07-24 (a past event whose outcome is known; this exercises the pipeline, it is not a claim about the Olympics) |
| Sources | en.wikipedia.org, whyy.org, boston.com (three sites; each page states the postponement) |
| Window | 300 s |
| Round 1 | `assess()` -> POSTPONED (PROVISIONAL, deadline = tx time + 300); `finalize()` after the window -> FINALIZED, `last_finalized_status` POSTPONED |
| Round 2 | same sequence on the same instance -> FINALIZED, `last_finalized_round` 2, `history_count` 6 |
| Studio transaction status | Deploy, `start_round`, `assess`, `finalize` all FINALIZED (round 1) |

What this does **not** show: a conflict between sources, a challenge on a live
network, behaviour when a source is unreachable, cost, or more than two runs. Two
identical outcomes are weak evidence of stability, not proof.

Studio is a hosted development network and can be reset; if the address above no
longer resolves, the raw values in `evidence/live-run-1.txt` are the record.

## Known limitations

- **Source trust.** The owner chooses the three sources. "Different sites" is a
  heuristic (last two labels, or three for common second-level suffixes such as
  `co.uk`, `com.tr`), not the public-suffix list, and does not prove the sources
  are editorially independent.
- **Griefing is bounded, not eliminated.** A challenge needs a page on a
  configured host that really changes the outcome, and its effect ends with the
  round. A successful hostile page can still force the owner to start a new
  round; rounds are capped at 20, after which the feed stops.
- **Stale pages.** A permanent old announcement that contradicts a new one yields
  `CONFLICT`. There is no version or date ordering.
- **Prompt injection** is mitigated (untrusted-data wrapper, JSON-encoded page,
  strict output shape, verbatim-quote check) but not eliminated.
- **Fetch failures** count as `UNKNOWN`; with only two explicit sources, one
  transient failure can turn a decision into `UNKNOWN` or make a leader be
  rejected.
- **Cost** is 3 to 6 page fetches and model calls per assessment and per
  re-read, multiplied by the number of validators. Not measured.
- A decision is an LLM-extracted reading of public pages. It is not a legal
  determination.
