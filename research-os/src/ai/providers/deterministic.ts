import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
} from '../provider';
import { EMBEDDING_DIMENSIONS, estimateTokens, modelFor } from '../provider';
import { normalizeText, tokenize, truncate } from '../../lib/text';

/**
 * A self-contained AI provider that requires no network access and no API
 * key.
 *
 * This is not a mock that returns canned strings: it does real (if
 * unsophisticated) analysis of the text it is given -- extractive
 * summarization, lexical classification against the supplied taxonomy,
 * regex-based study and claim extraction, and a hashing embedding. That
 * makes the entire ingestion, search and synthesis pipeline runnable end
 * to end in local development, CI and tests, with stable outputs that
 * tests can assert on.
 *
 * It is deliberately conservative: it reports low confidence, marks
 * everything for human review, and prefers `null` over a guess. Set
 * AI_PROVIDER=anthropic (or openai) for production-quality enrichment.
 */
export class DeterministicProvider implements AiProvider {
  readonly name = 'deterministic';

  async complete<T extends z.ZodTypeAny>(
    req: CompletionRequest<T>,
  ): Promise<CompletionResult<z.infer<T>>> {
    const text = (req.untrustedContent ?? []).map((c) => c.text).join('\n\n');
    const payload = req.payload ?? {};
    const raw = this.buildOutput(req.schemaName, text, payload);

    // The output goes through the same validation as any network provider,
    // so a change here cannot produce a shape the pipeline does not expect.
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Deterministic provider produced output failing ${req.schemaName}: ${parsed.error.message}`,
      );
    }

    return {
      data: parsed.data,
      usage: {
        inputTokens: estimateTokens(text + req.instruction),
        outputTokens: estimateTokens(JSON.stringify(raw)),
        model: 'deterministic',
        provider: this.name,
      },
    };
  }

  /**
   * Hashing embedding: tokens and bigrams are hashed into fixed
   * dimensions with sublinear term weighting, then L2-normalized. Cosine
   * similarity therefore rises with genuine lexical overlap, which is
   * enough for the hybrid ranker to be exercised realistically offline.
   */
  async embed(texts: string[]): Promise<EmbeddingResult> {
    const vectors = texts.map((text) => {
      const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      const tokens = tokenize(text);
      const features = [...tokens];
      for (let i = 0; i + 1 < tokens.length; i += 1) {
        features.push(`${tokens[i]}_${tokens[i + 1]}`);
      }

      const counts = new Map<string, number>();
      for (const feature of features) {
        counts.set(feature, (counts.get(feature) ?? 0) + 1);
      }

      for (const [feature, count] of counts) {
        const digest = createHash('md5').update(feature).digest();
        const index = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
        // Signed hashing keeps unrelated collisions from accumulating.
        const sign = (digest[4] & 1) === 0 ? 1 : -1;
        vector[index] += sign * (1 + Math.log(count));
      }

      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      return norm > 0 ? vector.map((v) => v / norm) : vector;
    });

    return {
      vectors,
      usage: {
        inputTokens: texts.reduce((sum, t) => sum + estimateTokens(t), 0),
        model: modelFor('embedding'),
        provider: this.name,
      },
    };
  }

  async rerank(query: string, documents: string[]): Promise<number[]> {
    const queryTokens = new Set(tokenize(query));
    return documents.map((doc) => {
      const docTokens = tokenize(doc);
      if (docTokens.length === 0 || queryTokens.size === 0) return 0;
      let overlap = 0;
      for (const token of new Set(docTokens)) if (queryTokens.has(token)) overlap += 1;
      return overlap / queryTokens.size;
    });
  }

  // -------------------------------------------------------------------
  // Per-schema output construction
  // -------------------------------------------------------------------

  private buildOutput(
    schemaName: string,
    text: string,
    payload: Record<string, unknown>,
  ): unknown {
    switch (schemaName) {
      case 'MetadataExtraction':
        return this.metadata(text, payload);
      case 'Summary':
        return this.summary(text);
      case 'Classification':
        return this.classification(text, payload);
      case 'StudyExtraction':
        return this.study(text);
      case 'ClaimExtraction':
        return this.claims(text);
      case 'ContradictionAnalysis':
        return this.contradictions(payload);
      case 'EvidenceAssessment':
        return this.evidence(text, payload);
      case 'Synthesis':
        return this.synthesis(text, payload);
      case 'QueryUnderstanding':
        return this.queryUnderstanding(payload);
      case 'GeneratedContent':
        return this.content(payload);
      case 'BriefSection':
        return this.brief(payload);
      default:
        throw new Error(`Deterministic provider has no handler for schema ${schemaName}`);
    }
  }

  private metadata(text: string, payload: Record<string, unknown>): unknown {
    const doiMatch = text.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i);
    const pmidMatch = text.match(/\bPMID:?\s*(\d{4,9})\b/i);
    const yearMatch = text.match(/\b(19|20)\d{2}\b/);

    return {
      title: (payload.title as string) ?? this.firstLine(text) ?? null,
      subtitle: null,
      authors: [],
      publisher: (payload.publisher as string) ?? null,
      journal: null,
      publication_date: yearMatch ? `${yearMatch[0]}-01-01` : null,
      source_type: this.detectSourceType(text, payload),
      language: 'en',
      country: null,
      doi: doiMatch ? doiMatch[0].toLowerCase() : null,
      pmid: pmidMatch ? pmidMatch[1] : null,
      abstract: this.extractAbstract(text),
      funding_information: this.matchSection(text, /funding[^.\n]{0,60}[:.]\s*([^\n]{10,300})/i),
      conflicts_of_interest: this.matchSection(
        text,
        /(?:conflicts? of interest|competing interests)[^.\n]{0,40}[:.]\s*([^\n]{5,300})/i,
      ),
      retraction_indicators: /\bretract(?:ed|ion)\b/i.test(text) ? ['Mentions retraction'] : [],
      confidence: 0.4,
    };
  }

  private detectSourceType(text: string, payload: Record<string, unknown>): string {
    const declared = payload.source_type as string | undefined;
    if (declared) return declared;
    const lower = text.toLowerCase();
    if (/\bmeta-analys/i.test(lower)) return 'meta_analysis';
    if (/\bsystematic review\b/i.test(lower)) return 'systematic_review';
    if (/\brandomi[sz]ed controlled trial\b|\bRCT\b/i.test(text)) {
      return 'randomized_controlled_trial';
    }
    if (/\bcohort stud/i.test(lower)) return 'cohort_study';
    if (/\bcase[- ]control\b/i.test(lower)) return 'case_control_study';
    if (/\bcross[- ]sectional\b/i.test(lower)) return 'cross_sectional_study';
    if (/\bclinical (?:practice )?guideline/i.test(lower)) return 'clinical_guideline';
    return 'web_article';
  }

  /** Extractive summary: leading sentences plus the highest-signal ones. */
  private summary(text: string): unknown {
    const sentences = splitSentences(text);
    if (sentences.length === 0) {
      return {
        one_sentence: 'No readable text was extracted from this source.',
        short: 'No readable text was extracted from this source.',
        detailed: 'No readable text was extracted from this source.',
        key_findings: [],
        practical_implications: [],
        limitations: [],
        safety_implications: [],
        questions_requiring_review: ['Extraction produced no text; verify the source manually.'],
        confidence: 0.1,
      };
    }

    const scored = scoreSentences(sentences);
    const top = scored.slice(0, 5).sort((a, b) => a.index - b.index);

    return {
      one_sentence: truncate(sentences[0], 300),
      short: truncate(sentences.slice(0, 3).join(' '), 700),
      detailed: truncate(top.map((s) => s.text).join(' '), 2000),
      key_findings: sentences
        .filter((s) => /\b(found|showed|demonstrated|reported|associated with|resulted in|reduced|increased|improved)\b/i.test(s))
        .slice(0, 5)
        .map((s) => truncate(s, 300)),
      practical_implications: sentences
        .filter((s) => /\b(recommend|should|suggests that|implication|in practice|clinicians)\b/i.test(s))
        .slice(0, 3)
        .map((s) => truncate(s, 300)),
      limitations: sentences
        .filter((s) => /\b(limitation|small sample|short duration|did not|unable to|caution|confounding|self-reported)\b/i.test(s))
        .slice(0, 4)
        .map((s) => truncate(s, 300)),
      safety_implications: sentences
        .filter((s) => /\b(adverse|side effect|contraindicat|hypoglyc|risk of harm|safety|warning|toxicity)\b/i.test(s))
        .slice(0, 3)
        .map((s) => truncate(s, 300)),
      questions_requiring_review: [
        'Confirm that the extracted summary reflects the source accurately before approval.',
      ],
      confidence: 0.35,
    };
  }

  private classification(text: string, payload: Record<string, unknown>): unknown {
    const candidates = (payload.candidate_categories ?? []) as Array<{
      id: string;
      name: string;
      synonyms?: string[];
    }>;
    const tokens = new Set(tokenize(text));

    const scored = candidates
      .map((category) => {
        const terms = [category.name, ...(category.synonyms ?? [])];
        let hits = 0;
        let possible = 0;
        for (const term of terms) {
          const termTokens = tokenize(term);
          if (termTokens.length === 0) continue;
          possible += 1;
          // A multi-word term counts only when the whole phrase appears.
          const matched = termTokens.every((t) => tokens.has(t));
          if (matched) hits += 1;
        }
        const confidence = possible === 0 ? 0 : Math.min(0.85, 0.3 + 0.5 * (hits / possible));
        return { category, hits, confidence };
      })
      .filter((c) => c.hits > 0)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 6);

    return {
      categories: scored.map((s) => ({
        category_id: s.category.id,
        name: s.category.name,
        confidence: Number(s.confidence.toFixed(3)),
        rationale: `Matched taxonomy term in the source text.`,
      })),
      tags: topKeywords(text, 6).map((word) => ({ name: word, confidence: 0.3 })),
      // Never proposes new taxonomy: inventing categories is exactly the
      // judgement a low-confidence provider should not be making.
      proposed_new_categories: [],
      recommended_collection_ids: [],
      confidence: scored.length > 0 ? 0.4 : 0.15,
    };
  }

  private study(text: string): unknown {
    const isStudy =
      /\b(participants|randomi[sz]ed|trial|cohort|sample size|n\s*=\s*\d+|control group|placebo)\b/i.test(
        text,
      );

    const field = <T>(value: T | null, excerpt: string | null = null, confidence = 0.3) => ({
      value,
      confidence: value === null ? 0 : confidence,
      evidence_excerpt: excerpt,
      locator: null,
    });

    const sampleMatch = text.match(/\bn\s*=\s*(\d{1,7})\b/i) ?? text.match(/\b(\d{2,7})\s+participants\b/i);
    const durationMatch = text.match(/\b(\d{1,3})\s*(weeks?|months?|years?|days?)\b/i);
    const designMatch = text.match(
      /\b(randomi[sz]ed controlled trial|randomi[sz]ed cross-?over|systematic review|meta-analysis|prospective cohort|retrospective cohort|case-control|cross-sectional)\b/i,
    );

    return {
      is_study: isStudy,
      study_design: field(designMatch ? designMatch[1].toLowerCase() : null, designMatch?.[0] ?? null, 0.5),
      registration_identifier: field(
        text.match(/\b(NCT\d{8}|CTRI\/\d{4}\/\d{2}\/\d+|ISRCTN\d+)\b/i)?.[0] ?? null,
      ),
      sample_size: field(sampleMatch ? Number(sampleMatch[1]) : null, sampleMatch?.[0] ?? null, 0.5),
      population_description: field(null),
      inclusion_criteria: field(null),
      exclusion_criteria: field(null),
      age_range: field(text.match(/\baged?\s+(\d{1,2}\s*(?:-|to|–)\s*\d{1,2})\b/i)?.[1] ?? null),
      sex_distribution: field(null),
      geography: field(null),
      setting: field(null),
      intervention: field(null),
      comparator: field(/\bplacebo\b/i.test(text) ? 'placebo' : null),
      duration: field(durationMatch ? durationMatch[0] : null, durationMatch?.[0] ?? null, 0.4),
      follow_up_duration: field(null),
      primary_outcomes: field(null),
      secondary_outcomes: field(null),
      effect_sizes: field(matchAll(text, /\b(?:OR|RR|HR|SMD|MD)\s*=?\s*-?\d+\.?\d*\b/gi, 5)),
      confidence_intervals: field(
        matchAll(text, /\b95%\s*CI[:\s]*[-\d.]+\s*(?:to|,|–|-)\s*[-\d.]+/gi, 5),
      ),
      p_values: field(matchAll(text, /\bp\s*[<>=]\s*0?\.\d+/gi, 5)),
      attrition_rate: field(null),
      adverse_events: field(null),
      statistical_methods: field(null),
      funding_source: field(null),
      conflicts_of_interest: field(null),
      limitations: field(null),
      risk_of_bias: field(null),
      pico_population: field(null),
      pico_intervention: field(null),
      pico_comparator: field(null),
      pico_outcomes: field(null),
      overall_confidence: isStudy ? 0.35 : 0.1,
    };
  }

  /**
   * Only sentences that both assert a relationship and carry a
   * quantitative or comparative marker become claims. Treating every
   * sentence as a claim is the failure this guards against.
   */
  private claims(text: string): unknown {
    const sentences = splitSentences(text);
    const claims = sentences
      .map((sentence, index) => ({ sentence, index }))
      .filter(({ sentence }) => {
        const assertive =
          /\b(reduced|increased|improved|lowered|raised|associated with|led to|resulted in|was more effective|significantly)\b/i.test(
            sentence,
          );
        const measurable = /\d|\bsignificant\b|\bcompared (?:to|with)\b/i.test(sentence);
        return assertive && measurable && sentence.length > 40 && sentence.length < 400;
      })
      .slice(0, 8)
      .map(({ sentence }) => ({
        canonical_text: truncate(sentence.trim(), 400),
        simplified_text: truncate(sentence.trim(), 200),
        population: null,
        intervention: null,
        comparator: /\bcompared (?:to|with)\s+([^,.]{3,60})/i.exec(sentence)?.[1]?.trim() ?? null,
        outcome: null,
        timeframe: /\b(\d{1,3})\s*(weeks?|months?|years?)\b/i.exec(sentence)?.[0] ?? null,
        qualifiers: /\bmay\b|\bmight\b|\bsuggests\b|\bpreliminary\b/i.test(sentence)
          ? ['stated tentatively in the source']
          : [],
        quantitative_value: /(-?\d+\.?\d*)\s*%/.exec(sentence)?.[0] ?? null,
        units: /%/.test(sentence) ? 'percent' : null,
        source_excerpt: truncate(sentence.trim(), 500),
        locator: null,
        claim_nature: /\brecommend|\bshould\b/i.test(sentence)
          ? ('recommendation' as const)
          : /\bwe believe\b|\bin our view\b/i.test(sentence)
            ? ('author_opinion' as const)
            : ('source_finding' as const),
        safety_relevant: /\badverse|\bhypoglyc|\brisk\b|\bcontraindicat/i.test(sentence),
        extraction_confidence: 0.3,
      }));

    return { claims };
  }

  private contradictions(payload: Record<string, unknown>): unknown {
    const others = (payload.comparison_targets ?? []) as Array<{
      claim_id?: string;
      source_id?: string;
      text: string;
    }>;
    const subject = (payload.subject_text as string) ?? '';
    const subjectDirection = direction(subject);

    return {
      assessments: others.map((other) => {
        const otherDirection = direction(other.text);
        const opposed =
          subjectDirection !== 'unclear' &&
          otherDirection !== 'unclear' &&
          subjectDirection !== otherDirection;

        return {
          other_claim_id: other.claim_id ?? null,
          other_source_id: other.source_id ?? null,
          // Opposite directions are a prompt to look, not a verdict. The
          // populations or endpoints may simply differ.
          classification: opposed
            ? ('true_contradiction' as const)
            : ('not_in_conflict' as const),
          dimensions_compared: ['direction_of_effect'],
          explanation: opposed
            ? 'The two statements describe opposite directions of effect. Compare population, intervention intensity, outcome definition and time horizon before treating this as a genuine contradiction.'
            : 'No opposing direction of effect was detected by lexical comparison.',
          confidence: 0.25,
          requires_human_review: true,
        };
      }),
    };
  }

  private evidence(text: string, payload: Record<string, unknown>): unknown {
    const sourceType = (payload.source_type as string) ?? 'other';
    const year = payload.publication_year as number | undefined;
    const sampleSize = payload.sample_size as number | undefined;

    const designStrength =
      sourceType === 'meta_analysis' || sourceType === 'systematic_review'
        ? 'high'
        : sourceType === 'randomized_controlled_trial'
          ? 'moderate'
          : sourceType === 'cohort_study' || sourceType === 'case_control_study'
            ? 'low'
            : sourceType === 'clinical_guideline'
              ? 'moderate'
              : 'unknown';

    const currentYear = new Date().getFullYear();
    const recency = !year
      ? 'unknown'
      : currentYear - year <= 3
        ? 'high'
        : currentYear - year <= 8
          ? 'moderate'
          : 'low';

    const sampleAdequacy = !sampleSize
      ? 'unknown'
      : sampleSize >= 1000
        ? 'high'
        : sampleSize >= 200
          ? 'moderate'
          : sampleSize >= 30
            ? 'low'
            : 'very_low';

    return {
      study_design_strength: designStrength,
      source_authority: sourceType === 'government_report' || sourceType === 'clinical_guideline' ? 'high' : 'unknown',
      sample_adequacy: sampleAdequacy,
      directness: 'unknown',
      consistency: 'unknown',
      precision: 'unknown',
      recency,
      population_relevance: 'unknown',
      conflict_of_interest_risk: /\bfunded by\b|\bsponsor/i.test(text) ? 'moderate' : 'unknown',
      overall_confidence: 'low',
      rationale:
        'Assessed from structural signals only (study design, publication year, reported sample size). Dimensions requiring judgement are reported as unknown and need a human reviewer.',
    };
  }

  /**
   * Synthesis is strictly extractive: every sentence in the answer is
   * copied from a retrieved passage and carries that passage's marker.
   * Nothing can be asserted that is not in the retrieval context.
   */
  private synthesis(_text: string, payload: Record<string, unknown>): unknown {
    const passages = (payload.passages ?? []) as Array<{
      marker: string;
      text: string;
      title?: string;
    }>;
    const question = (payload.question as string) ?? '';

    if (passages.length === 0) {
      return {
        answer:
          'No sources were retrieved for this question, so no evidence-backed answer can be given.',
        main_findings: [],
        contradictions: [],
        limitations: ['No sources matched the query within the selected scope.'],
        safety_notes: [],
        evidence_quality: 'No evidence available.',
        gaps: ['The library contains no material matching this question within the chosen scope.'],
        used_citation_markers: [],
      };
    }

    const queryTokens = new Set(tokenize(question));
    const ranked = passages
      .map((p) => {
        const sentences = splitSentences(p.text);
        const best = sentences
          .map((s) => ({ s, score: overlapScore(s, queryTokens) }))
          .sort((a, b) => b.score - a.score)[0];
        return { marker: p.marker, sentence: best?.s ?? sentences[0] ?? p.text, score: best?.score ?? 0 };
      })
      .filter((r) => r.sentence)
      .sort((a, b) => b.score - a.score);

    const findings = ranked.slice(0, 5).map((r) => ({
      statement: truncate(r.sentence.trim(), 400),
      citation_markers: [r.marker],
    }));

    const directions = ranked.slice(0, 6).map((r) => ({ ...r, dir: direction(r.sentence) }));
    const positive = directions.filter((d) => d.dir === 'increase');
    const negative = directions.filter((d) => d.dir === 'decrease');
    const contradictions =
      positive.length > 0 && negative.length > 0
        ? [
            {
              description:
                'Retrieved passages describe effects in opposing directions. Compare population, intervention intensity, outcome definition and follow-up duration before concluding that the sources genuinely disagree.',
              citation_markers: [...positive.slice(0, 2), ...negative.slice(0, 2)].map((d) => d.marker),
            },
          ]
        : [];

    return {
      answer: [
        `Based on ${passages.length} retrieved passage(s) within the selected scope:`,
        ...findings.map((f) => `${f.statement} ${f.citation_markers.join('')}`),
      ].join('\n\n'),
      main_findings: findings,
      contradictions,
      limitations: [
        'This synthesis was assembled by extracting the passages most lexically similar to the question. It does not weigh study quality.',
        'Confirm each cited passage against the source record before relying on this summary.',
      ],
      safety_notes: ranked
        .filter((r) => /\badverse|\bhypoglyc|\brisk\b|\bcontraindicat|\bsafety\b/i.test(r.sentence))
        .slice(0, 3)
        .map((r) => `${truncate(r.sentence.trim(), 300)} ${r.marker}`),
      evidence_quality:
        'Not assessed by this provider. Review the evidence assessment on each source record.',
      gaps: [],
      used_citation_markers: findings.flatMap((f) => f.citation_markers),
    };
  }

  private queryUnderstanding(payload: Record<string, unknown>): unknown {
    const query = (payload.query as string) ?? '';
    const lower = query.toLowerCase();

    const designs: string[] = [];
    if (/\brct\b|randomi[sz]ed|controlled trial/i.test(query)) {
      designs.push('randomized_controlled_trial');
    }
    if (/meta-analys/i.test(query)) designs.push('meta_analysis');
    if (/systematic review/i.test(query)) designs.push('systematic_review');

    const yearMatch = query.match(/\b(?:since|after|from)\s+((?:19|20)\d{2})\b/i);
    const recent = /\brecent\b|\blatest\b|\bnew\b/i.test(lower);

    return {
      semantic_query: query,
      keywords: topKeywords(query, 8),
      synonyms: [],
      population: /\b(?:in|among|for)\s+([a-z ]{3,50}?)(?:\s+with\b|,|$)/i.exec(query)?.[1]?.trim() ?? null,
      intervention: null,
      comparator: null,
      outcome: null,
      study_designs: designs,
      source_types: [],
      published_after: yearMatch
        ? `${yearMatch[1]}-01-01`
        : recent
          ? `${new Date().getFullYear() - 5}-01-01`
          : null,
      published_before: null,
      geography: /\bindia|indian\b/i.test(lower) ? ['India'] : [],
      requested_output: /\bcompare\b/i.test(lower)
        ? ('comparison' as const)
        : /\bbrief\b/i.test(lower)
          ? ('brief' as const)
          : /\bclaim/i.test(lower)
            ? ('claims' as const)
            : /\bevidence\b/i.test(lower)
              ? ('evidence' as const)
              : ('sources' as const),
    };
  }

  private content(payload: Record<string, unknown>): unknown {
    const passages = (payload.passages ?? []) as Array<{ marker: string; text: string }>;
    const title = (payload.title as string) ?? 'Untitled draft';

    if (passages.length === 0) {
      return {
        title,
        sections: [],
        unsupported_claims: [],
        safety_flags: [
          'No approved sources were available, so no content was drafted. Widen the source selection or approve relevant sources first.',
        ],
      };
    }

    return {
      title,
      sections: [
        {
          heading: 'Evidence summary',
          body: passages
            .slice(0, 8)
            .map((p) => `${truncate(splitSentences(p.text)[0] ?? p.text, 400)} ${p.marker}`)
            .join('\n\n'),
          citation_markers: passages.slice(0, 8).map((p) => p.marker),
        },
      ],
      unsupported_claims: [],
      safety_flags: [
        'Drafted by extracting cited passages. A human writer and, for health-facing content, a clinical reviewer must revise this before publication.',
      ],
    };
  }

  private brief(payload: Record<string, unknown>): unknown {
    const passages = (payload.passages ?? []) as Array<{ marker: string; text: string }>;
    const requested = (payload.sections ?? []) as string[];
    const question = (payload.research_question as string) ?? '';

    const markers = passages.map((p) => p.marker);
    const body = (heading: string): string => {
      switch (heading) {
        case 'executive_summary':
          return passages.length === 0
            ? 'No sources were selected for this brief.'
            : `Question: ${question}\n\n${passages
                .slice(0, 4)
                .map((p) => `${truncate(splitSentences(p.text)[0] ?? p.text, 300)} ${p.marker}`)
                .join('\n\n')}`;
        case 'methodology':
          return `Assembled from ${passages.length} passage(s) drawn from the sources attached to this brief, ranked by lexical similarity to the research question. Study quality was not weighted; review each source's evidence assessment.`;
        case 'findings':
          return passages
            .slice(0, 10)
            .map((p) => `- ${truncate(splitSentences(p.text)[0] ?? p.text, 300)} ${p.marker}`)
            .join('\n');
        case 'contradictions':
          return 'No contradiction analysis was performed by this provider. Run contradiction analysis on the relevant claims.';
        case 'limitations':
          return '- This brief was assembled extractively and does not weigh study quality.\n- Verify each citation against the source record before circulating.';
        case 'recommendations':
          return 'Recommendations require human judgement and are intentionally left for a reviewer to write.';
        case 'safety_notes':
          return (
            passages
              .filter((p) => /\badverse|\bhypoglyc|\brisk\b|\bcontraindicat/i.test(p.text))
              .slice(0, 4)
              .map((p) => `- ${truncate(splitSentences(p.text)[0] ?? p.text, 300)} ${p.marker}`)
              .join('\n') || 'No safety-relevant passages were detected in the selected sources.'
          );
        default:
          return 'Not generated.';
      }
    };

    const sections: Record<string, string> = {};
    for (const heading of requested.length > 0
      ? requested
      : ['executive_summary', 'methodology', 'findings', 'limitations']) {
      sections[heading] = body(heading);
    }

    return { sections, citation_markers: markers };
  }

  // -------------------------------------------------------------------

  private firstLine(text: string): string | null {
    const line = normalizeText(text).split('\n').find((l) => l.trim().length > 10);
    return line ? truncate(line.trim(), 300) : null;
  }

  private extractAbstract(text: string): string | null {
    const match = text.match(/\babstract\b[:\s]*([\s\S]{50,2000}?)(?:\n\n|\bintroduction\b)/i);
    if (match) return truncate(match[1].trim(), 2000);
    const sentences = splitSentences(text);
    return sentences.length > 0 ? truncate(sentences.slice(0, 4).join(' '), 1200) : null;
  }

  private matchSection(text: string, pattern: RegExp): string | null {
    const match = text.match(pattern);
    return match ? truncate(match[1].trim(), 300) : null;
  }
}

// ---------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------

export function splitSentences(text: string): string[] {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+(?=[A-Z(])|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'were', 'was', 'are',
  'have', 'has', 'had', 'not', 'but', 'they', 'their', 'which', 'these',
  'those', 'been', 'more', 'than', 'also', 'may', 'can', 'will', 'would',
  'could', 'should', 'about', 'into', 'over', 'such', 'when', 'them',
  'there', 'here', 'other', 'some', 'only', 'both', 'each', 'between',
]);

function scoreSentences(sentences: string[]): Array<{ text: string; index: number; score: number }> {
  const frequencies = new Map<string, number>();
  for (const sentence of sentences) {
    for (const token of tokenize(sentence)) {
      if (STOPWORDS.has(token)) continue;
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
  }

  return sentences
    .map((text, index) => {
      const tokens = tokenize(text).filter((t) => !STOPWORDS.has(t));
      if (tokens.length === 0) return { text, index, score: 0 };
      const total = tokens.reduce((sum, t) => sum + (frequencies.get(t) ?? 0), 0);
      // Position bonus: the opening of an article carries the thesis.
      const positionBonus = index < 3 ? 1.3 : 1;
      return { text, index, score: (total / tokens.length) * positionBonus };
    })
    .sort((a, b) => b.score - a.score);
}

function topKeywords(text: string, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    if (STOPWORDS.has(token) || token.length < 4) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function overlapScore(sentence: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const tokens = tokenize(sentence);
  let hits = 0;
  for (const token of new Set(tokens)) if (queryTokens.has(token)) hits += 1;
  return hits / queryTokens.size;
}

function direction(text: string): 'increase' | 'decrease' | 'unclear' {
  const up = /\b(increase[sd]?|higher|improve[sd]?|raise[sd]?|greater|rose|beneficial|effective)\b/i.test(text);
  const down = /\b(decrease[sd]?|lower(?:ed)?|reduce[sd]?|declin|smaller|fell|less|no benefit|ineffective)\b/i.test(text);
  if (up && !down) return 'increase';
  if (down && !up) return 'decrease';
  return 'unclear';
}

function matchAll(text: string, pattern: RegExp, limit: number): string[] | null {
  const matches = [...text.matchAll(pattern)].slice(0, limit).map((m) => m[0]);
  return matches.length > 0 ? matches : null;
}
