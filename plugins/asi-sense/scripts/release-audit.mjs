const allowed = new Set([
  'LICENSE',
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js',
  'lib/typert.host.js',
  'lib/asi-sense-helper',
  'scripts/dsh.sh',
]);

export function auditFiles(files, read, username) {
  for (const { path } of files) {
    if (!allowed.has(path)) throw new Error(`Unexpected package file: ${path}`);
    const text = read(path).toString('latin1').toLowerCase();
    if (/\/(?:users|home)\/|\/private\/(?:tmp|var)\/|\/var\/folders\/|[a-z]:\\users\\/i.test(text)) {
      throw new Error(`Local absolute path in ${path}`);
    }
    if (username && text.includes(username.toLowerCase())) throw new Error(`Local username in ${path}`);
  }
}

export function registryVersionAvailable(status, stdout) {
  if (status === 0) return false;
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error('Registry lookup failed without a JSON response');
  }
  if (result?.error?.code === 'E404') return true;
  throw new Error(`Registry lookup failed: ${result?.error?.code ?? 'unknown error'}`);
}

export function registryUrl(value = 'https://registry.npmjs.org/') {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid release registry URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Release registry must be an HTTP(S) URL without credentials, query or fragment');
  }
  return url.href;
}

export { allowed };
