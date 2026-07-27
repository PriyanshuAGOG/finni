import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
} from '../provider';
import { UNTRUSTED_CONTENT_PREAMBLE, fenceUntrusted, modelFor } from '../provider';
import { getEnv } from '../../lib/env';
import { embedWithConfiguredProvider } from './embedding';

/**
 * OpenAI Chat Completions provider using strict JSON Schema structured
 * outputs, so the response is guaranteed to match the requested shape
 * before it is validated again with Zod.
 */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';

  async complete<T extends z.ZodTypeAny>(
    req: CompletionRequest<T>,
  ): Promise<CompletionResult<z.infer<T>>> {
    const env = getEnv();
    if (!env.AI_API_KEY) {
      throw new Error('AI_API_KEY must be set when AI_PROVIDER=openai.');
    }

    const model = modelFor(req.capability);
    const generated = zodToJsonSchema(req.schema, {
      name: req.schemaName,
      $refStrategy: 'none',
    }) as Record<string, unknown>;
    const schema =
      ((generated.definitions as Record<string, unknown> | undefined)?.[req.schemaName] as
        | Record<string, unknown>
        | undefined) ?? generated;

    const userContent = [
      req.instruction,
      req.payload ? `\nStructured input:\n${JSON.stringify(req.payload, null, 2)}` : '',
      req.untrustedContent && req.untrustedContent.length > 0
        ? `\n${UNTRUSTED_CONTENT_PREAMBLE}\n\n${req.untrustedContent
            .map((c) => fenceUntrusted(c.label, c.text))
            .join('\n\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const response = await fetch(
      `${env.AI_BASE_URL ?? 'https://api.openai.com/v1'}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.AI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          temperature: req.temperature ?? 0,
          max_tokens: req.maxTokens ?? 4096,
          messages: [
            { role: 'system', content: `${req.system}\n\n${UNTRUSTED_CONTENT_PREAMBLE}` },
            { role: 'user', content: userContent },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: req.schemaName, schema, strict: false },
          },
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI API returned ${response.status}: ${body.slice(0, 500)}`);
    }

    const json = (await response.json()) as {
      choices: Array<{ message: { content: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = json.choices[0]?.message?.content;
    if (!content) throw new Error('OpenAI response contained no content.');

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new Error('OpenAI response was not valid JSON.');
    }

    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `OpenAI output failed ${req.schemaName} validation: ${parsed.error.message.slice(0, 400)}`,
      );
    }

    return {
      data: parsed.data,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        model,
        provider: this.name,
      },
    };
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    return embedWithConfiguredProvider(texts);
  }
}
