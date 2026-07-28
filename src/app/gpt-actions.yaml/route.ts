import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Rewrites the servers block to this request's actual origin below, so
// it can't be static -- a custom domain or preview deployment would
// otherwise see the placeholder committed in openapi/gpt-actions.yaml.
export const dynamic = 'force-dynamic';

const PLACEHOLDER_SERVER_URL = 'https://research.nirogbhoomi.com/api/v1';

/**
 * Serves openapi/gpt-actions.yaml so it can be imported by URL when
 * configuring the Custom GPT's Actions (GPT editor -> Configure ->
 * Actions -> Import from URL), rather than requiring a copy-paste of
 * the file contents. The generator (scripts/generate-openapi.ts) can't
 * know the deployment's real domain at build time, so this route swaps
 * in the actual request origin -- ChatGPT then calls the right host
 * regardless of custom domain or preview URL.
 */
export async function GET(request: Request): Promise<Response> {
  const content = await readFile(join(process.cwd(), 'openapi', 'gpt-actions.yaml'), 'utf8');
  const origin = new URL(request.url).origin;
  const rewritten = content.replace(PLACEHOLDER_SERVER_URL, `${origin}/api/v1`);

  return new Response(rewritten, {
    headers: {
      'content-type': 'application/yaml; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
