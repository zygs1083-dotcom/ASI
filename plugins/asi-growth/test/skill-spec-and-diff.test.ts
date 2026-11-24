import { describe, expect, it } from 'vitest';
import { computeLineDiff } from '../src/shared/diff.js';
import {
  isValidSkillName,
  parseSkillMarkdown,
  renderSkillMarkdown,
  toValidSkillSlug,
  validateSkillDocument,
} from '../src/shared/skill-spec.js';

describe('agentskills SKILL.md parser, validator, sanitizer, and line diff', () => {
  it('parses, validates, and round-trips canonical SKILL.md documents', () => {
    const raw = [
      '---',
      'name: playwright-a11y-check',
      'description: Run 320px responsive overflow and axe-core contrast checks on sidebar panels.',
      'when-to-use: Use when modifying sidebar React components or CSS modules.',
      'license: MIT',
      'metadata:',
      '  version: "1.0.0"',
      '  topic-key: playwright-a11y',
      '---',
      '',
      '# Playwright A11y Checklist',
      '',
      '## Standard Procedure',
      '1. Verify light and dark themes at 320px width.',
    ].join('\n');

    const parsed = parseSkillMarkdown(raw);
    expect(parsed.valid).toBe(true);
    expect(parsed.document?.name).toBe('playwright-a11y-check');
    expect(parsed.document?.whenToUse).toContain('sidebar React components');
    expect(parsed.document?.metadata?.['topic-key']).toBe('playwright-a11y');

    if (!parsed.document) throw new Error('expected parsed document');
    const rendered = renderSkillMarkdown(parsed.document);
    const reparsed = parseSkillMarkdown(rendered);
    expect(reparsed.valid).toBe(true);
    expect(reparsed.document?.name).toBe('playwright-a11y-check');
    expect(reparsed.document?.body).toContain('## Standard Procedure');
  });

  it('rejects invalid names, short descriptions, missing frontmatter, mismatched dir names, and bundled script executables', () => {
    expect(isValidSkillName('valid-skill-1')).toBe(true);
    expect(isValidSkillName('BadUpper')).toBe(false);
    expect(isValidSkillName('-leading')).toBe(false);
    expect(isValidSkillName('trailing-')).toBe(false);
    expect(isValidSkillName('double--hyphen')).toBe(false);
    expect(isValidSkillName('a'.repeat(65))).toBe(false);

    expect(parseSkillMarkdown('# No frontmatter').valid).toBe(false);

    const shortDesc = validateSkillDocument({
      name: 'ok-name',
      description: 'too short',
      body: '# Body',
    });
    expect(shortDesc.valid).toBe(false);
    expect(shortDesc.errors.join(' ')).toContain('at least 10');

    const mismatchDir = validateSkillDocument(
      {
        name: 'skill-a',
        description: 'Valid description with more than ten characters.',
        body: '# Body',
      },
      { expectedDirName: 'skill-b' },
    );
    expect(mismatchDir.valid).toBe(false);
    expect(mismatchDir.errors.join(' ')).toContain('must match directory name');

    const withExecutableScript = validateSkillDocument({
      name: 'bad-script-skill',
      description: 'Valid description for testing bundled script rejection.',
      body: '# Steps\n1. Execute `./scripts/cleanup.sh` to mutate files.',
    });
    expect(withExecutableScript.valid).toBe(false);
    expect(withExecutableScript.errors.join(' ')).toContain('scripts/*');

    const withNestedScript = validateSkillDocument({
      name: 'bad-nested-script',
      description: 'Valid description for testing nested bundled script rejection.',
      body: '# Steps\n1. Execute [helper](../scripts/nested/exfiltrate.ts) to mutate files.',
    });
    expect(withNestedScript.valid).toBe(false);

    const withFrontmatterScript = validateSkillDocument({
      name: 'bad-fm-script',
      description: 'Valid description for testing frontmatter script rejection.',
      whenToUse: 'Run ./scripts/sub/deploy.bash before release.',
      body: '# Safe Body\n1. Check types.',
    });
    expect(withFrontmatterScript.valid).toBe(false);

    const overlongWhenRaw = [
      '---',
      'name: overlong-when-skill',
      'description: Valid description for testing overlong when-to-use rejection.',
      `when-to-use: ${'x'.repeat(510)}`,
      '---',
      '',
      '# Body',
    ].join('\n');
    const overlongWhenParsed = parseSkillMarkdown(overlongWhenRaw);
    expect(overlongWhenParsed.valid).toBe(false);
    expect(overlongWhenParsed.errors.join(' ')).toContain('when-to-use');

    const dirtyMetaKeyTok = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'].join('_');
    const dirtyMetaRaw = [
      '---',
      'name: dirty-meta-key',
      'description: Valid description for testing credential metadata key rejection.',
      'metadata:',
      `  ${dirtyMetaKeyTok}: secret`,
      '---',
      '',
      '# Body',
    ].join('\n');
    expect(parseSkillMarkdown(dirtyMetaRaw).valid).toBe(false);

    const specialYamlValues = renderSkillMarkdown({
      name: 'yaml-edge-scalars',
      description: 'Valid description for testing YAML special scalar quoting.',
      metadata: {
        tilde: '~',
        hyphen: '- leading-item',
        [dirtyMetaKeyTok]: 'dropped-key',
      },
      body: '# Body\n1. Verify round-trip.',
    });
    const reparsedSpecial = parseSkillMarkdown(specialYamlValues);
    expect(reparsedSpecial.valid).toBe(true);
    expect(reparsedSpecial.document?.metadata?.tilde).toBe('~');
    expect(reparsedSpecial.document?.metadata?.hyphen).toBe('- leading-item');
  });

  it('redacts single-line, blank-line cross-line, Unicode zero-width, and multi-line PEM credentials while preserving Markdown newlines', () => {
    const fakeGhp = ['ghp', '\u200bA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'].join('_');
    const rawGhpAscii = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
    const fakeCrossSecret = ['SuperSecret99', 'TokenValue8877'].join('_');
    const pemHeader = ['-----', 'BEGIN OPENSSH PRIVATE KEY', '-----'].join('');
    const pemTailShort = 'ShortKeyTail9876==';
    const pemFooter = ['-----', 'END OPENSSH PRIVATE KEY', '-----'].join('');
    const fakeHome = ['', 'Users', 'inventedtester'].join('/');

    const dirtyMd = [
      '---',
      'name: redaction-guard-test',
      `description: Safely handle local config under ${fakeHome}/proj without leaking ${fakeGhp}.`,
      '---',
      '',
      '# Redaction Guard',
      '',
      `- Config path: ${fakeHome}/.config/demo.json`,
      '- Blank-line separated auth header:',
      'Authorization:',
      '',
      `  ${fakeCrossSecret}`,
      '- Embedded PEM block:',
      pemHeader,
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMw==',
      pemTailShort,
      pemFooter,
      '- Keep normal step formatting intact.',
    ].join('\n');

    const parsed = parseSkillMarkdown(dirtyMd, fakeHome);
    expect(parsed.valid).toBe(true);
    if (!parsed.document) throw new Error('expected parsed document');
    const out = renderSkillMarkdown(parsed.document, fakeHome);
    expect(out).not.toContain(rawGhpAscii);
    expect(out).not.toContain(fakeCrossSecret);
    expect(out).not.toContain(pemTailShort);
    expect(out).not.toContain(fakeHome);
    expect(out).toContain('~/proj');
    expect(out).toContain('~/.config/demo.json');
    expect(out).toContain('[redacted]');
    expect(out).toContain('# Redaction Guard\n');
  });

  it('generates valid slugs for English, mixed, and pure CJK topics and computes v1 -> v2 line diffs', () => {
    expect(toValidSkillSlug('Playwright Contrast & Theme!!')).toBe('playwright-contrast-theme');
    const cjkSlug = toValidSkillSlug('侧栏对比度与无障碍验证');
    expect(isValidSkillName(cjkSlug)).toBe(true);
    expect(cjkSlug).toContain('contrast-theme');

    const pureUnknownCjk = toValidSkillSlug('纯中文生僻主题词');
    expect(isValidSkillName(pureUnknownCjk)).toBe(true);

    const diff = computeLineDiff('# Title\n- step 1\n- old line', '# Title\n- step 1\n- new pitfall guardrail');
    expect(diff.some((d) => d.kind === 'remove' && d.text === '- old line')).toBe(true);
    expect(diff.some((d) => d.kind === 'add' && d.text === '- new pitfall guardrail')).toBe(true);
    expect(diff.some((d) => d.kind === 'context' && d.text === '# Title')).toBe(true);
  });
});
