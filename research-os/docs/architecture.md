# Architecture

## System overview

```mermaid
flowchart TB
    subgraph clients["Interfaces"]
        Dashboard["Dashboard (Next.js pages)"]
        GPT["Custom GPT (ChatGPT Actions)"]
        Assistant["Internal AI Assistant"]
        Ext["Future: browser extension, partners"]
    end

    subgraph api["Versioned API — /api/v1"]
        Handler["handler.ts\nauth · rate limit · idempotency · audit-on-failure"]
        Registry["Operation registry\n(single source of truth)"]
    end

    subgraph services["Shared domain services"]
        SourceSvc["SourceService / IngestionService"]
        SearchSvc["SearchService / SynthesisService"]
        ClaimSvc["ClaimService"]
        TaxSvc["TaxonomyService / CollectionService"]
        ResearchSvc["ResearchService"]
        BriefSvc["BriefService / ContentService"]
        ConfirmSvc["ConfirmationService"]
        AuditSvc["AuditService"]
        AuthSvc["AuthService / PermissionService"]
    end

    subgraph data["Data layer"]
        PG[("PostgreSQL\n+ pgvector, RLS")]
    end

    subgraph worker["Worker"]
        Queue["processing_jobs\n(Postgres-backed queue)"]
        Handlers["Stage handlers:\nextract → summarize → classify →\nstudy_metadata → claims → embeddings → evidence"]
    end

    subgraph ai["AI abstraction layer"]
        Provider["Provider interface"]
        Anthropic["Anthropic"]
        OpenAI["OpenAI"]
        Deterministic["Deterministic\n(offline, no key)"]
    end

    Dashboard -->|server components call services directly| services
    Dashboard --> Handler
    GPT --> Handler
    Assistant --> Handler
    Ext -.-> Handler
    Handler --> Registry
    Registry --> services
    services --> PG
    services --> Queue
    Queue --> Handlers
    Handlers --> services
    services --> Provider
    Provider --> Anthropic
    Provider --> OpenAI
    Provider --> Deterministic
```

**One domain model.** The dashboard, the API (and therefore the Custom GPT and any future integration), and the worker all call the same service functions in `src/services/*.ts`. There is no separate, weaker path for GPT-originated writes — permission checks, confirmation gating, and audit logging happen inside the service layer itself, so they apply identically regardless of which interface triggered the call.

## Ingestion and enrichment data flow

```mermaid
sequenceDiagram
    actor User
    participant API as API / Dashboard
    participant Ing as IngestionService
    participant DB as PostgreSQL
    participant Q as Job Queue
    participant W as Worker
    participant AI as AI Provider

    User->>API: ingestUrl(url)
    API->>Ing: ingestUrl()
    Ing->>Ing: normalize URL, SSRF guard
    Ing->>DB: check duplicates (hash, DOI, PMID, URL, SimHash+Jaccard)
    alt duplicate found
        Ing-->>API: DUPLICATE_SOURCE (409) + existing record
    else no duplicate
        Ing->>Ing: fetch + extract (Readability / PDF / YouTube)
        Ing->>DB: INSERT source (review_status=needs_review)
        Ing->>DB: INSERT source_version (v1)
        Ing->>Q: enqueue summarize, classify, study_metadata,
        Ing->>Q: claims, embeddings, evidence_assessment
        Ing-->>API: 200 { source_id, processing_status: queued }
    end
    API-->>User: source id, dashboard URL, "unreviewed" warning

    loop each queued stage
        W->>Q: claim next job (FOR UPDATE SKIP LOCKED)
        W->>AI: structured, schema-validated call
        AI-->>W: validated JSON (never free text)
        W->>DB: write enrichment (never overwrites human fields / locked fields)
        W->>DB: complete job / retry with backoff / dead-letter
    end
```

Every AI call in this flow is schema-validated (Zod) before anything is written — a response that doesn't match the expected shape is treated as a failure, not partially trusted. Retrieved and ingested content is always wrapped in an explicit untrusted-content boundary (`UNTRUSTED_CONTENT_PREAMBLE` in `src/ai/provider.ts`) so an instruction embedded in a scraped article cannot redirect the model's behavior.

## Search and synthesis data flow

```mermaid
flowchart LR
    Q["User query"] --> QU["Query understanding\n(structured filters extracted)"]
    QU --> Hybrid["Hybrid ranking"]
    Hybrid --> FTS["Full-text\n(ts_rank_cd)"]
    Hybrid --> Vec["Vector similarity\n(pgvector)"]
    Hybrid --> Ident["Exact identifier\n(DOI / PMID)"]
    Hybrid --> Tax["Taxonomy match"]
    Hybrid --> Evid["Evidence-strength\nby study design"]
    Hybrid --> Appr["Approval status"]
    Hybrid --> Rec["Recency\n(saturating, not linear)"]
    Hybrid --> Rerank["Rerank"]
    FTS & Vec & Ident & Tax & Evid & Appr & Rec & Rerank --> Results["Ranked results\nwith origin label:\ninternal_approved / unreviewed / archived / external_web / mixed"]
    Results --> Synth["synthesizeKnowledge\n(model sees ONLY retrieved passages)"]
    Synth --> Verify["Citation verification\n(marker not in context → stripped)"]
    Verify --> Answer["Cited answer"]
```

## Entity relationships (core subset)

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ USERS : has
    ORGANIZATIONS ||--o{ SOURCES : has
    USERS ||--o{ USER_ROLES : has
    ROLES ||--o{ USER_ROLES : grants

    SOURCES ||--o{ SOURCE_VERSIONS : "captured as"
    SOURCES ||--o{ EMBEDDING_CHUNKS : "chunked into"
    SOURCES ||--o{ SOURCE_CATEGORIES : "tagged with"
    CATEGORIES ||--o{ SOURCE_CATEGORIES : "applied to"
    SOURCES ||--o{ SOURCE_TAGS : "tagged with"
    TAGS ||--o{ SOURCE_TAGS : "applied to"
    SOURCES ||--o{ STUDY_METADATA : "may have"
    SOURCES ||--o{ EVIDENCE_ASSESSMENTS : "assessed by"
    SOURCES ||--o{ ANNOTATIONS : "annotated with"

    CLAIMS ||--o{ CLAIM_EVIDENCE : "backed by"
    SOURCES ||--o{ CLAIM_EVIDENCE : "evidences"
    CLAIMS ||--o{ ANNOTATIONS : "annotated with"

    COLLECTIONS ||--o{ COLLECTION_SOURCES : contains
    SOURCES ||--o{ COLLECTION_SOURCES : "member of"

    RESEARCH_JOBS ||--o{ RESEARCH_CANDIDATES : produces
    RESEARCH_CANDIDATES }o--o| SOURCES : "ingested as"

    RESEARCH_BRIEFS ||--o{ BRIEF_SOURCES : cites
    SOURCES ||--o{ BRIEF_SOURCES : "cited by"

    GENERATED_CONTENT ||--o{ GENERATED_CONTENT_CITATIONS : cites
    SOURCES ||--o{ GENERATED_CONTENT_CITATIONS : "cited by"

    PROCESSING_JOBS }o--|| SOURCES : processes
    AUDIT_LOGS }o--|| USERS : "attributed to"
    ACTION_CONFIRMATIONS }o--|| USERS : "issued to"
```

The full schema (32 tables) is in `db/migrations/0001`–`0005`. Every major table carries `organization_id`, `created_at`/`updated_at`, `created_by`/`updated_by`, and — where soft-deletion applies — `archived_at`/`archived_by`.

## Security layers (defense in depth)

1. **Application-level permission checks** (`requirePermission`) at both the service function and the API handler — a service refactor cannot silently open an endpoint, because the handler checks independently.
2. **Scope checks** for token-based callers (OAuth, API key) — the intersection of scope and permission is what's actually authorized; neither alone is sufficient.
3. **Row-level security** in Postgres itself — even a service-layer bug that forgets an `organization_id` filter cannot leak cross-organization rows, verified in `tests/integration/rls.test.ts` by attempting exactly that.
4. **SSRF guard** on every fetched URL (`src/extraction/fetch.ts`) — resolves and checks every hop's IP against private/link-local/metadata ranges before connecting.
5. **Prompt-injection containment** — untrusted content is always fenced and preceded by an explicit instruction boundary; the AI provider layer is the only place ingested text reaches a model.
6. **Server-issued confirmation** for high/critical-risk actions — a conversational "yes" from any interface is never itself authorization; the confirmation token is bound to the exact action, resource set, and payload hash, and can only be used once.
