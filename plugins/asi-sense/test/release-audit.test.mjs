import { describe, expect, it } from 'vitest';
import { auditFiles, registryUrl, registryVersionAvailable } from '../scripts/release-audit.mjs';

describe('release audit', () => {
  it('accepts only the intended files without local paths or usernames', () => {
    expect(() => auditFiles([{ path: 'lib/index.js' }], () => Buffer.from('safe'), 'exampleuser')).not.toThrow();
    for (const path of ['.env', 'lib/secrets.env', 'lib/index.test.js', 'docs/reviews/result.md']) {
      expect(() => auditFiles([{ path }], () => Buffer.from('safe'), 'exampleuser')).toThrow();
    }
    for (const text of ['/Users/example/file', '/home/example/file', 'exampleuser']) {
      expect(() => auditFiles([{ path: 'lib/index.js' }], () => Buffer.from(text), 'exampleuser')).toThrow();
    }
  });

  it('accepts a registry 404 but fails closed on existing versions and other errors', () => {
    expect(registryVersionAvailable(1, '{"error":{"code":"E404"}}')).toBe(true);
    expect(registryVersionAvailable(0, '"0.1.2"')).toBe(false);
    expect(() => registryVersionAvailable(1, '{"error":{"code":"E403"}}')).toThrow();
    expect(() => registryVersionAvailable(1, '')).toThrow();
  });

  it('accepts an explicit registry without embedded credentials', () => {
    expect(registryUrl()).toBe('https://registry.npmjs.org/');
    expect(registryUrl('http://127.0.0.1:4873/')).toBe('http://127.0.0.1:4873/');
    for (const value of [
      'file:///tmp/registry',
      'https://user:secret@example.com/',
      'https://example.com/?token=secret',
    ]) {
      expect(() => registryUrl(value)).toThrow();
    }
  });
});
