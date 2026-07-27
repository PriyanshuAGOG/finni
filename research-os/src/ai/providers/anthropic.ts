import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
} from '../provider';
import {
  UNTRUSTED_CONTENT_PREAMBLE,
  fenceUntrusted,
  modelFor,
} from '../provider';
import { getEnv } from '../../lib/env';
import { embedWithConfiguredProvider } from './embedding';

interface AnthropicToolUseBlock {
  type: 'tool_use';
  name: string;
  input: unknown;
}

interface AnthropicResponse {
  content: Array<AnthropicToolUseBlock | { type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

/**
 * Anthropic Messages API provider.
 *
 * Structured output is obtained by declaring a single tool whose input
 * schema is the JSON Schema form of the caller's Zod schema, and forcing
 * that tool. The model therefore returns a typed object rather than prose
 * that has to be parsed out of a code fence.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly apiVersion = '2023-06-01';

  async complete<T extends z.ZodTypeAny>(
    req: CompletionRequest<T>,
  ): Promise<CompletionResult<z.infer<T>>> {
    const env = getEnv();
    if (!env.AI_API_KEY) {
      throw new Error('AI_API_KEY must be set when AI_PROVIDER=anthropic.');
    }

    const model = modelFor(req.capability);
    const jsonSchema = zodToJsonSchema(req.schema, {
      name: req.schemaName,
      $refStrategy: 'none',
    }) as Record<string, unknown>;
    const inputSchema =
      ((jsonSchema.definitions as Record<string, unknown> | undefined)?.[req.schemaName] as
        | Record<string, unknown>
        | undefined) ?? jsonSchema;

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

    const response = await fetch(`${env.AI_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.AI_API_KEY,
        'anthropic-version': this.apiVersion,
      },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0,
        system: `${req.system}\n\n${UNTRUSTED_CONTENT_PREAMBLE}`,
        messages: [{ role: 'user', content: userContent }],
        tools: [
          {
            name: 'emit_result',
            description: `Return the result as a ${req.schemaName} object.`,
            input_schema: { type: 'object', ...inputSchema },
          },
        ],
        tool_choice: { type: 'tool', name: 'emit_result' },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API returned ${response.status}: ${body.slice(0, 500)}`);
    }

    const json = (await response.json()) as AnthropicResponse;
    const block = json.content.find(
      (c): c is AnthropicToolUseBlock =>
        c.type === 'tool_use' && (c as AnthropicToolUseBlock).name === 'emit_result',
    );
    if (!block) {
      throw new Error('Anthropic response did not contain the expected structured result.');
    }

    // Validation is not optional: an unvalidated model response must
    // never reach the database.
    const parsed = req.schema.safeParse(block.input);
    if (!parsed.success) {
      throw new Error(
        `Anthropic output failed ${req.schemaName} validation: ${parsed.error.message.slice(0, 400)}`,
      );
    }

    return {
      data: parsed.data,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        model,
        provider: this.name,
      },
    };
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    return embedWithConfiguredProvider(texts);
  }
}
