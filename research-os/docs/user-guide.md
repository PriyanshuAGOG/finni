# User Guide

## Adding research

- **A single URL**: Library → Add Source → paste the URL. If it's already in the library, you'll be shown the existing record instead of a duplicate.
- **Several URLs at once**: use the batch option, or ask the Research Assistant / Custom GPT to save a list.
- **A DOI or PubMed ID**: paste it directly — metadata is resolved automatically via Crossref / PubMed.
- **A PDF or pasted text**: upload the file, or paste the text as a manual source when there's no fetchable URL.

Everything you add starts **unreviewed**. It's searchable and visible in the Research Inbox immediately, but it does not count as approved organizational evidence until someone with review permission approves it.

## Understanding review status

| Status | Meaning |
| --- | --- |
| `needs_review` / `unreviewed` | Just added, nobody has looked at it yet. |
| `in_review` | Someone is actively reviewing it. |
| `approved` / `approved_with_conditions` | Counts as organizational evidence. Conditions (if any) are shown on the record. |
| `rejected` | Reviewed and declined, with a stated reason. |
| `disputed` | Was approved, now under question. |
| `superseded` | Replaced by a newer, stronger source — both records stay linked. |

Search and the assistant always tell you which of these you're looking at — never assume something found in search is approved.

## Searching and asking questions

The Search page (and the Custom GPT) support two modes:

- **Library only** — approved sources exclusively, closest to "what can we officially say."
- **Library first** — searches approved material first, and can widen to unreviewed or external sources when asked.

Check "Generate cited answer" for a synthesized response with numbered citations back to real passages — every citation is checked against what was actually retrieved before it's shown to you, so a citation you see is never invented.

## Organizing: categories, tags, collections

- **Categories** are the controlled taxonomy (hierarchical, curated) — the system actively warns you before creating one that's a near-duplicate of an existing one.
- **Tags** are lightweight and created on the fly.
- **Collections** group sources around a topic, research question, or project (e.g. a content brief's source pool).

## Claims and evidence

A claim is one specific, checkable statement — not a topic. Each claim shows its supporting, contradicting and qualifying evidence separately, with the exact excerpt and passage locator. A claim's evidence status updates automatically from its evidence *until* a clinical reviewer signs off on it — after that, new evidence flags it for **re-review** instead of silently changing the verdict underneath the reviewer.

## Research briefs and content

Briefs and generated content are built the same way as a synthesized answer: from a fixed, approved-by-default set of sources, with a citation on every factual statement. `validateContentCitations` independently re-checks a draft's statements against its cited sources before you rely on it — use it before publishing anything.

## Using the Custom GPT

The GPT can do anything your account can do in the dashboard — no more, no less. It will always tell you plainly when something is unreviewed or external, and it will ask you to explicitly confirm anything high-risk (archiving, merging, bulk changes) before it happens — it cannot skip that step. Ask "what did you just do?" any time to see exactly what changed.
