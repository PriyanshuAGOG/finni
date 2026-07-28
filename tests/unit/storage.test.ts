import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionForContentType, getStorageDriver, resetStorageDriverCache } from '../../src/lib/storage';
import { resetEnvCache } from '../../src/lib/env';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nirog-storage-test-'));
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_PATH = dir;
  resetEnvCache();
  resetStorageDriverCache();
});

afterEach(async () => {
  delete process.env.STORAGE_LOCAL_PATH;
  resetEnvCache();
  resetStorageDriverCache();
  await rm(dir, { recursive: true, force: true });
});

describe('local storage driver', () => {
  it('round-trips data and content type', async () => {
    const driver = getStorageDriver();
    const data = Buffer.from('<html>hello</html>', 'utf8');
    await driver.put('sources/abc/snapshot.html', data, 'text/html');

    const stored = await driver.get('sources/abc/snapshot.html');
    expect(stored).not.toBeNull();
    expect(stored?.data.toString('utf8')).toBe('<html>hello</html>');
    expect(stored?.contentType).toBe('text/html');
  });

  it('returns null for a key that was never written', async () => {
    const driver = getStorageDriver();
    expect(await driver.get('sources/does-not-exist/original.pdf')).toBeNull();
  });

  it('deletes stored data so a later get returns null', async () => {
    const driver = getStorageDriver();
    await driver.put('sources/xyz/original.txt', Buffer.from('text'), 'text/plain');
    await driver.delete('sources/xyz/original.txt');
    expect(await driver.get('sources/xyz/original.txt')).toBeNull();
  });

  it('rejects a key that attempts path traversal', async () => {
    const driver = getStorageDriver();
    await expect(driver.put('../../etc/passwd', Buffer.from('x'), 'text/plain')).rejects.toThrow();
  });
});

describe('extensionForContentType', () => {
  it('maps known content types to their extension', () => {
    expect(extensionForContentType('application/pdf')).toBe('.pdf');
    expect(extensionForContentType('text/html; charset=utf-8')).toBe('.html');
    expect(extensionForContentType('text/plain')).toBe('.txt');
  });

  it('falls back to a generic extension for an unrecognized content type', () => {
    expect(extensionForContentType('application/octet-stream')).toBe('.bin');
  });
});
