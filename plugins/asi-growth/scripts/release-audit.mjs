const allowed = new Set([
  'LICENSE',
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js',
  'lib/typert.host.js',
  'scripts/dsh.sh',
]);

const safeMatches = new Set(
  Object.entries({
    'lib/index.js': ['/-/g', '/_/g'],
    'lib/typert.host.js': ['gateway/bad-request', '/-/g', '/_/g'],
    'lib/client.js': ['gateway/carrier-lost', '/-/g', '/_/g'],
    'scripts/dsh.sh': ['/bin/sh', '/dev/null'],
  }).flatMap(([path, matches]) => matches.map((match) => `${path}:${match}`)),
);

const sensitive = [
  [
    'credential',
    /(?:npm_|ghp_|github_pat_)[a-z0-9_-]{8,}|glpat-[a-z0-9_-]{8,}|xox[abprs]-[a-z0-9-]{8,}|AIza[a-z0-9_-]{8,}|sk-[a-z0-9_-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN\b/gi,
  ],
  ['email', /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi],
  [
    'absolute path',
    /(?<![a-z0-9_.:/])\/(?:(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+|(?:users|home|opt|private\/var|var\/folders)\/)|[a-z]:\\(?:[^\\\s"'`]+\\)*[^\\\s"'`]+/gi,
  ],
  ['source map', /sourceMappingURL\s*=/gi],
];

export function auditFiles(files, read, username) {
  for (const { path } of files) {
    if (!allowed.has(path)) throw new Error(`Unexpected package file: ${path}`);
    const bytes = read(path);
    const texts = [bytes.toString('latin1')];
    for (const offset of [0, 1]) {
      const aligned = bytes.subarray(offset, bytes.length - ((bytes.length - offset) % 2));
      texts.push(aligned.toString('utf16le'), Buffer.from(aligned).swap16().toString('utf16le'));
    }
    for (const original of texts) {
      const text = original
        .replace(/\\\//g, '/')
        .replace(/\\\\/g, '\\')
        .replace(/file:\/\//gi, '');
      for (const [kind, pattern] of sensitive) {
        for (const match of text.matchAll(pattern)) {
          if (!safeMatches.has(`${path}:${match[0]}`)) throw new Error(`Possible ${kind} in ${path}: ${match[0]}`);
        }
      }
      if (username && text.toLowerCase().includes(username.toLowerCase())) throw new Error(`Local username in ${path}`);
    }
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

export function extractClientCssClasses(bundleText, bundleLabel = 'client.js') {
  const match = /const __asi(?:Needs|Sleep|Growth)Styles=("(?:\\.|[^"\\])*");/.exec(bundleText);
  if (!match?.[1]) {
    throw new Error(`Missing embedded stylesheet constant in ${bundleLabel}`);
  }
  const cssText = JSON.parse(match[1]);
  const sanitizedCss = cssText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
    .replace(/@(?:-webkit-)?keyframes\s+[^{]+\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, '');

  const classes = new Set();
  const blocks = sanitizedCss.split('{');
  for (let i = 0; i < blocks.length - 1; i += 1) {
    const rawBeforeBrace = blocks[i] ?? '';
    const boundaryIdx = Math.max(rawBeforeBrace.lastIndexOf('}'), rawBeforeBrace.lastIndexOf(';'));
    const prelude = rawBeforeBrace
      .slice(boundaryIdx + 1)
      .trim()
      .replace(/\[[^\]]*\]/g, '');
    if (!prelude || prelude.startsWith('@')) continue;
    for (const cm of prelude.matchAll(/\.([A-Za-z_-][A-Za-z0-9_-]*)/g)) {
      if (cm[1]) classes.add(cm[1]);
    }
  }
  return classes;
}

export function assertPairwiseDisjointClientCss({ needsBundle, sleepBundle, growthBundle }) {
  const needsClasses = extractClientCssClasses(needsBundle, 'asi-needs/lib/client.js');
  const sleepClasses = extractClientCssClasses(sleepBundle, 'asi-sleep/lib/client.js');
  const growthClasses = extractClientCssClasses(growthBundle, 'asi-growth/lib/client.js');

  for (const [label, set] of [
    ['asi-needs/lib/client.js', needsClasses],
    ['asi-sleep/lib/client.js', sleepClasses],
    ['asi-growth/lib/client.js', growthClasses],
  ]) {
    if (set.size <= 10) {
      throw new Error(`Expected >10 CSS Module classes in ${label}, found ${set.size}`);
    }
  }

  const pairs = [
    ['asi-needs vs asi-sleep', needsClasses, sleepClasses],
    ['asi-needs vs asi-growth', needsClasses, growthClasses],
    ['asi-sleep vs asi-growth', sleepClasses, growthClasses],
  ];
  for (const [pairLabel, left, right] of pairs) {
    const overlap = [...left].filter((cls) => right.has(cls));
    if (overlap.length > 0) {
      throw new Error(`CSS Module class overlap detected (${pairLabel}): ${overlap.join(', ')}`);
    }
  }

  return {
    needsCount: needsClasses.size,
    sleepCount: sleepClasses.size,
    growthCount: growthClasses.size,
  };
}

export { allowed };
