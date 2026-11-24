/**
 * Compact pure-TypeScript LCS line diff for inspecting `v1 -> v2+` `SKILL.md`
 * revisions inside the `GrowthPanel` sidebar without external diff packages.
 */

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
  oldLine?: number;
  newLine?: number;
}

const MAX_DIFF_LINES = 400;

export function computeLineDiff(beforeText: string, afterText: string): DiffLine[] {
  const oldLines = beforeText.replace(/\r\n?/g, '\n').trimEnd().split('\n').slice(0, MAX_DIFF_LINES);
  const newLines = afterText.replace(/\r\n?/g, '\n').trimEnd().split('\n').slice(0, MAX_DIFF_LINES);

  const m = oldLines.length;
  const n = newLines.length;
  const width = n + 1;
  const dp = new Uint16Array((m + 1) * width);

  for (let i = m - 1; i >= 0; i -= 1) {
    const oldLine = oldLines[i];
    for (let j = n - 1; j >= 0; j -= 1) {
      const idx = i * width + j;
      if (oldLine === newLines[j]) {
        dp[idx] = (dp[(i + 1) * width + (j + 1)] ?? 0) + 1;
      } else {
        const down = dp[(i + 1) * width + j] ?? 0;
        const right = dp[i * width + (j + 1)] ?? 0;
        dp[idx] = down >= right ? down : right;
      }
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    const a = oldLines[i] ?? '';
    const b = newLines[j] ?? '';
    if (a === b) {
      out.push({ kind: 'context', text: a, oldLine: i + 1, newLine: j + 1 });
      i += 1;
      j += 1;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + (j + 1)] ?? 0)) {
      out.push({ kind: 'remove', text: a, oldLine: i + 1 });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b, newLine: j + 1 });
      j += 1;
    }
  }
  while (i < m) {
    out.push({ kind: 'remove', text: oldLines[i] ?? '', oldLine: i + 1 });
    i += 1;
  }
  while (j < n) {
    out.push({ kind: 'add', text: newLines[j] ?? '', newLine: j + 1 });
    j += 1;
  }
  return out;
}
