# User Guide

## Adding research

- **A single URL**: Library → Add Source → paste the URL. If it's already in the library, you'll be shown the existing record instead of a duplicate.
- **Several URLs at once**: use the batch option, or ask the Research Assistant / Custom GPT to save a list.
- **A DOI or PubMed ID**: paste it directly — metadata is resolved automatically via Crossref / PubMed.
- **A PDF or pasted text**: upload the file, or paste the text as a manual source when there's no fetchable URL.

Every successfully saved source is available immediately. Processing and AI enrichment may continue in the background, but there is no source approval queue.

Every active source is automatically filed into exactly one of four categories: **Movement, Exercise and Yoga**, **Lifestyle**, **Food**, or **Miscellaneous**.

## Searching and asking questions

The Search page (and the Custom GPT) support two modes:

- **Library only** — searches the internal Nirog Bhoomi library only.
- **Library first** — searches the internal library first and can use external discovery when the internal library does not cover the question or when you explicitly request recent external research.

Check "Generate cited answer" for a synthesized response with numbered citations back to real passages — every citation is checked against what was actually retrieved before it's shown to you, so a citation you see is never invented.

## Organizing: categories, tags, collections

- **Categories** are fixed to Movement, Exercise and Yoga; Lifestyle; Food; and Miscellaneous. Assignment is automatic.
- **Tags** are lightweight and created on the fly.
- **Collections** group sources around a topic, research question, or project (e.g. a content brief's source pool).

## Claims and evidence

A claim is one specific, checkable statement — not a topic. Each claim shows its supporting, contradicting and qualifying evidence separately, with the exact excerpt and passage locator. A claim's evidence status updates automatically from its evidence *until* a clinical reviewer signs off on it — after that, new evidence flags it for **re-review** instead of silently changing the verdict underneath the reviewer.

## Research briefs and content

Briefs and generated content are built from selected active library sources, with a citation on every factual statement. `validateContentCitations` independently re-checks a draft's statements against its cited sources before you rely on it — use it before publishing anything.

## Using the Custom GPT

The GPT can do anything its connected account and scopes allow — no more, no less. It distinguishes internal library evidence from external discovery, and it will ask you to explicitly confirm anything high-risk (archiving, merging, bulk changes) before it happens — it cannot skip that step. Ask "what did you just do?" any time to see exactly what changed.
