import { Client, Storage } from 'node-appwrite';
import { getEnv } from '../src/lib/env';

/**
 * Creates the Appwrite Storage bucket used for source snapshots, if it
 * doesn't already exist. Safe to run more than once.
 *
 * File-level access is never granted here -- every read and write goes
 * through this app's own API, which applies its own permission model
 * (roles, scopes, RLS) on top of Postgres. The bucket only needs to be
 * reachable by the server-side API key, not by end users directly.
 */
async function main() {
  const env = getEnv();

  if (env.STORAGE_DRIVER !== 'appwrite') {
    console.log(
      `STORAGE_DRIVER is "${env.STORAGE_DRIVER}", not "appwrite" -- nothing to provision. ` +
        'Set STORAGE_DRIVER=appwrite (and the APPWRITE_* variables) to use this script.',
    );
    return;
  }
  if (!env.APPWRITE_ENDPOINT || !env.APPWRITE_PROJECT_ID || !env.APPWRITE_API_KEY) {
    throw new Error(
      'APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY must all be set.',
    );
  }

  const client = new Client()
    .setEndpoint(env.APPWRITE_ENDPOINT)
    .setProject(env.APPWRITE_PROJECT_ID)
    .setKey(env.APPWRITE_API_KEY);
  const storage = new Storage(client);

  const bucketId = env.APPWRITE_BUCKET_ID;

  const existing = await storage.getBucket({ bucketId }).catch((err: unknown) => {
    if (isNotFound(err)) return null;
    throw err;
  });

  if (existing) {
    console.log(`Bucket "${bucketId}" already exists. Nothing to do.`);
    return;
  }

  await storage.createBucket({
    bucketId,
    name: 'Research OS source snapshots',
    // No Permission entries: only requests carrying the server API key
    // (this script, and the app's AppwriteStorageDriver) can read or
    // write files here. fileSecurity stays off for the same reason --
    // per-file permissions would only matter if end users hit this
    // bucket directly, which they never do.
    fileSecurity: false,
    enabled: true,
    maximumFileSize: env.MAX_UPLOAD_BYTES,
    encryption: true,
    antivirus: true,
  });

  console.log(`Created bucket "${bucketId}".`);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 404;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
