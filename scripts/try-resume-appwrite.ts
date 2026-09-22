import { closePool } from '../src/lib/db';

async function main() {
  const endpoint = process.env.APPWRITE_ENDPOINT?.trim();
  const projectId = process.env.APPWRITE_PROJECT_ID?.trim();
  const apiKey = process.env.APPWRITE_API_KEY?.trim();
  if (!endpoint || !projectId || !apiKey) {
    throw new Error('Appwrite environment is incomplete.');
  }

  const regionBase = new URL(endpoint);
  const base = `${regionBase.protocol}//${regionBase.host}/v1`;
  console.log('APPWRITE_PROJECT', JSON.stringify({ projectId, host: regionBase.host }));

  const headers = {
    'content-type': 'application/json',
    'x-appwrite-project': projectId,
    'x-appwrite-key': apiKey,
    'x-appwrite-response-format': '2.2.0',
  };

  const candidates = [
    {
      url: `${base}/projects/${projectId}`,
      body: { status: 'active' },
    },
    {
      url: `${base}/project`,
      body: { status: 'active' },
    },
  ];

  for (const candidate of candidates) {
    const response = await fetch(candidate.url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(candidate.body),
    });
    const text = await response.text();
    console.log('RESUME_ATTEMPT', JSON.stringify({
      path: new URL(candidate.url).pathname,
      status: response.status,
      body: text.slice(0, 800),
    }));
    if (response.ok) {
      console.log('RESUME_ACCEPTED');
      return;
    }
  }

  throw new Error('Appwrite resume was not accepted with the existing server credential.');
}

main().catch(async (err) => {
  console.error('APPWRITE_RESUME_FAILED', err instanceof Error ? err.message : String(err));
  try { await closePool(); } catch {}
  process.exit(1);
});
