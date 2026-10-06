# Temporal edges: relationships with dates

GBrain records when a relationship between two pages started and ended, and
graph reads return what is true today unless you ask for history. "Who works at
acme-example?" lists current employees; former employees stay one parameter
away.

**Say to your agent:**
- *"Who works at acme-example now?"*
- *"Where did alice-example work in 2022?"*
- *"Show me former employees of acme-example."*
- *"Mark that alice-example left acme-example on 2025-03-01."*

## What carries a date

Relationship types fall into three groups:

| Group | Types | Behavior |
|---|---|---|
| State | `works_at`, `advises`, `yc_partner` | starts and can end; may have several stints (left and rejoined) |
| Event | `founded`, `invested_in`, `led_round`, `attended`, `discussed_in`, `cited` | happened on a date and stays true; hidden in as-of reads before that date |
| Reference | `mentions`, `source`, `owes_to`, `awaiting_reply_from`, untyped links, … | no temporal state; always returned |

Open-loop edges (`owes_to`, `awaiting_reply_from`) keep their own lifecycle in
open loops.

A schema pack adds its own relations to the first two groups with
`link_types[].temporal`:

```yaml
link_types:
  - name: reports_to
    inverse: manages
    temporal: state     # can end: reads return the manager true today
  - name: promoted
    temporal: event
```

The table above is the default; a pack declaration wins for its relation. The brain
uses the union of its active pack and every per-source pack, and `state` wins if two
packs disagree. `mentions` never carries a date. `gbrain schema lint` reports a
`temporal` on `mentions` (error), a built-in relation redeclared with different
semantics, and an inverse pair that disagrees (warnings). Natural-language cues
("left", "joined") date the built-in relations only; a pack relation takes its dates
from the explicit grammar (`Ended reports_to [[people/x]]`), frontmatter
`since`/`until`, and `add_link valid_from` / `valid_until`.

## How dates get recorded (no model calls)

Every write re-reads the page and records dated evidence for the relationships
the page states:

- **Timeline lines with a cue.** `- **2025-03-01** | linkedin — Left [Acme](../companies/acme-example) to join [Widget](../companies/widget-co)`
  ends `works_at acme-example` and starts `works_at widget-co` on that date. Cues are
  relation-specific: leaving a job does not end an advisory role. A cue only dates a
  relationship the page already states; it never creates one. "Moved from [A] to [B]"
  and "Left [A] for [B]" also start B.
  A cue moves a relationship only when it is about the relationship itself, so these
  lines change nothing: lines about investing, meetings or events ("Joined [Acme]'s
  Series B", "Back at [Acme] for an alumni dinner"), and references qualified by what
  follows ("[Acme]'s London office", "[Acme] alumni"). "[Acme]'s advisory board" is the
  one qualified form that dates `advises`. Write the explicit grammar below when such a
  line really is a job change.
- **The explicit line grammar**, inside a dated timeline entry. It names the relation
  and the target, so it works on its own, even after the old sentence is deleted:
  ```
  - **2025-03-01** | me — Ended works_at [[companies/acme-example]]
  - **2021-04-01** | me — Started advises [[companies/widget-co]]
  ```
- **Frontmatter `since` / `until`** on relationship objects:
  `company: [{ name: Acme, since: 2021-04, until: 2024-02-15 }]` (partial dates
  normalize to the first day of the month or year). List the company twice for a
  rejoin.
- **Past-tense prose.** "previously at", "former CTO of", "used to work at" mark the
  page's assertion as past ("has worked at" and "was promoted to CTO at" stay present).
  A relationship with no dated evidence at all then reads as ended at an unknown date;
  a dated start stays open until a dated end, whatever the prose says. On one page, a
  present-tense mention wins ("previously at Acme, now runs Acme's EU team" stays live).
- **Manual edges:** `add_link` accepts `valid_from` and `valid_until` (YYYY-MM-DD).
  Re-run `add_link` with `valid_until` to record that a relationship ended.

Dated evidence beats undated evidence from any page: a closure on a person's timeline
ends the relationship even if the company page still lists them under `key_people`.

## Reading

| Parameter | Meaning |
|---|---|
| (none) | relationships true today (UTC) |
| `status: "all"` | every relationship, each with `status`, `stints`, `recorded_at`, `retired_at` |
| `status: "ended"` | former relationships only (`get_links`) |
| `as_of: "2022-06-30"` | what was true on that day |
| `during: "2022"` | true at any point in a period (`2022`, `2022-03`, `2021..2023-06`) |

`get_links` takes all of them plus `link_type`; `get_backlinks` takes `status` (`live`,
`all`) and `as_of`; `traverse_graph` walks live relationships (read history with
`get_links` or `get_backlinks`). When a default read leaves relationships
out, the response carries a `former_relationships_hidden` notice with the exact call
that shows them, and `gbrain.temporal` response metadata with the count.

Recipe for "where did alice-example work in 2022":

```
get_links { slug: "people/alice-example", link_type: "works_at", during: "2022" }
```

Statuses in history reads:

| Status | Meaning |
|---|---|
| `live` | true at the reference date |
| `ended` | ended on a recorded date at or before the reference date |
| `ended_unknown_date` | stated as over, with no end date (excluded from as-of answers) |
| `not_started` | starts after the reference date |
| `disputed` | one page says it is current, another says it is over, no dates; returned live today and excluded from as-of answers |
| `event` | an event that has happened |
| `reference` | a plain reference with no temporal state |

The relational search arm follows the question's tense: "who works at" reads live
relationships, "who worked at" / "used to" reads history, "former employees of" reads
ended ones. Entity cards and `context_pack` keep every edge with its status and add a
relationship note, for example
`now: works_at widget-co (since 2025-03-01); ended: works_at acme-example (2025-03-01); summary may be stale: it still names acme-example`.
The same note follows a page into ambient turn context (appended to its synopsis) and into
compiled context files (a `relationships:` line under the excerpt), so an agent reading any
of them sees the ended relationship even when the summary has not been rewritten.

## The nightly relationship check

The dream cycle's `edge_contradictions` phase looks at subjects with two or more live
relationships of the same state type (two current employers). A chat model judges only
whether they can both hold now; date arithmetic decides which one ended and when: the
relationship that started earlier ends on the date the other started. Relationships
without a dated start are never closed; the proposal asks for a date instead.

A certified model passed a held-out run with no wrong closures, so with no explicit mode
its closures are applied as timeline lines, each undoable. Set
`dream.edge_contradictions.mode propose` to review every closure first.

The closure date is the newer relationship's start. When someone left one job and
started the next later, and only the "joined" lines are written, the earlier job closes
on the later start date: late, not wrong. An explicit end line
(`Ended works_at [[companies/x]]`) or a "left" line dates it exactly.

| Setting | Default |
|---|---|
| `dream.edge_contradictions.mode` | `apply` for certified models (`claude-haiku-4-5`, the utility default, plus `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`, `gpt-6.1-sol`); `propose` for any other chat model; `off` without one |
| `models.dream.edge_contradictions` | utility tier |
| `dream.edge_contradictions.max_subjects` | 200 per cycle |
| `dream.edge_contradictions.max_usd` | $1.00 per cycle |

Proposals:

```
gbrain edge-proposals list            # open proposals and undated pairs
gbrain edge-proposals accept 12       # writes the closure line, re-derives the page
gbrain edge-proposals reject 12
gbrain edge-proposals undo 12         # removes the line it wrote
gbrain edge-proposals undo --all-applied
gbrain edge-proposals date 14 2024-05-01   # record when the newer relationship started
```

An applied proposal is one timeline line on the subject page:

```
- **2024-05-01** | gbrain-dream (inferred) — Ended works_at [[companies/acme-example]] (superseded by works_at companies/widget-co)
```

Delete the line to reopen the relationship; the check records that and does not
propose it again until the evidence changes.

## Declared single-value relations

A schema pack can declare that a state relation has one current value per page, for
example a company brain where `works_at` means the one current employer:

```yaml
link_types:
  - name: works_at
    cardinality: one_per_from   # default: many
```

For a declared type the nightly check asks no model: the declaration already says two
live relationships cannot both hold. The chain rule orders the page's live
relationships by their latest dated start and ends each one on the date the next one
started, so an out-of-order import (Acme from January, Widget from March, then Gadget
from February) ends Acme in February and Gadget in March. Relationships without a dated
start, and two that start on the same date, stay open and appear in
`gbrain edge-proposals list`. Closures are recorded as proposals with model
`schema-pack:cardinality`; `gbrain edge-proposals accept <id>` writes one as the same
reversible timeline line.

- Only state relations take `cardinality`: the built-in ones (`works_at`, `advises`, `yc_partner`) and any type the
  pack declares `temporal: state`. `gbrain schema lint` rejects it elsewhere, because only state relations end.
- The declaration comes from the source's resolved pack. A child pack that redeclares
  the type replaces the whole entry, so it must restate `cardinality`.
- `gbrain schema cardinality-preview [--source <id>] [--json]` lists every page with
  more than one live relationship of a declared type and what the next dream cycle
  closes or leaves open. It writes nothing; run it before activating a pack that adds a
  declaration.
- `dream.single_value.mode` is `propose` by default: closures wait for review in
  `gbrain edge-proposals list`. `gbrain config set dream.single_value.mode apply` writes them
  automatically; `off` hands declared types back to the model judge. Held-out testing found
  wrong closures when an advisory timeline line ("Took an advisory role with X") counted as
  the start of a new job at X, so review proposals before accepting them.
- To stop further closures, remove the declaration. `gbrain edge-proposals undo <id>`
  (or deleting the line) reopens a relationship it closed.

Older gbrain releases reject a pack that uses `cardinality`, so set the pack's
`gbrain_min_version` to the release that adds it.

## Turning it off

- `gbrain config set graph.edge_validity off`: graph reads return every edge, as
  before. Dated evidence keeps being recorded, so turning it back on loses nothing.
- `gbrain config set dream.edge_contradictions.mode off`: no model-judged relationship checks
  (declared single-value relations follow `dream.single_value.mode`).
  Lines it already wrote stay until `gbrain edge-proposals undo --all-applied`.

## Health

`gbrain doctor --only edge_validity` reports relationships by status, relationships
whose state lags their evidence (the extract cycle sweeps them), pages that still
state a relationship their own timeline ended, and open proposals.
