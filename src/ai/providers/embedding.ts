import type { EmbeddingResult } from '../provider';
import { EMBEDDING_DIMENSIONS, estimateTokens, modelFor } from '../provider';
import { getEnv } from '../../lib/env';

/**
 * Embedding generation, selected independently of the completion
 * provider. Batches are sent in chunks so a large re-index does not
 * exceed provider request limits.
 */
export async function embedWithConfiguredProvider(texts: string[]): Promise<EmbeddingResult> {
  const env = getEnv();

  if (env.AI_EMBEDDING_PROVIDER === 'deterministic') {
    const { DeterministicProvider } = await import('./deterministic');
    return new DeterministicProvider().embed(texts);
  }

  if (!env.AI_EMBEDDING_API_KEY) {
    throw new Error('AI_EMBEDDING_API_KEY must be set when AI_EMBEDDING_PROVIDER=openai.');
  }

  const model = modelFor('embedding');
  const vectors: number[][] = [];
  let inputTokens = 0;
  const BATCH = 96;

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const response = await fetch(`${env.AI_EMBEDDING_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.AI_EMBEDDING_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        input: batch,
        // Requested at the storage dimension so no lossy client-side
        // projection is needed to fit the vector column.
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Embedding API returned ${response.status}: ${body.slice(0, 400)}`);
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      usage?: { prompt_tokens?: number };
    };

    const ordered = [...json.data].sort((a, b) => a.index - b.index);
    for (const item of ordered) {
      if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding provider returned ${item.embedding.length} dimensions; ${EMBEDDING_DIMENSIONS} expected.`,
        );
      }
      vectors.push(item.embedding);
    }
    inputTokens += json.usage?.prompt_tokens ?? batch.reduce((s, t) => s + estimateTokens(t), 0);
  }

  return { vectors, usage: { inputTokens, model, provider: 'openai' } };
}
