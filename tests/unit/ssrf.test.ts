import { describe, expect, it } from 'vitest';
import { assertPublicUrl } from '../../src/extraction/fetch';

describe('assertPublicUrl', () => {
  it('rejects loopback addresses', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/admin')).rejects.toThrow();
    await expect(assertPublicUrl('http://localhost/admin')).rejects.toThrow();
  });

  it('rejects private RFC1918 ranges', async () => {
    await expect(assertPublicUrl('http://10.0.0.5/')).rejects.toThrow();
    await expect(assertPublicUrl('http://192.168.1.1/')).rejects.toThrow();
    await expect(assertPublicUrl('http://172.16.0.1/')).rejects.toThrow();
  });

  it('rejects the cloud metadata address', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertPublicUrl('gopher://internal/')).rejects.toThrow();
  });

  it('rejects an unparsable URL', async () => {
    await expect(assertPublicUrl('::::not a url')).rejects.toThrow();
  });

  it('accepts a well-formed public https URL', async () => {
    const url = await assertPublicUrl('https://example.com/article');
    expect(url.hostname).toBe('example.com');
  });
});
