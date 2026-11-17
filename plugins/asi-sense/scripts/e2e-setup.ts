import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_RULES } from '../src/host/attention/rules.ts';
import { defaultBodyRules } from '../src/host/body/index.ts';

export async function setup({
  root,
  home,
  workspace,
  sessionRoot,
  counter,
  budgetReady,
  services,
  limit,
}: {
  root: string;
  home: string;
  workspace: string;
  sessionRoot: string;
  counter: string;
  budgetReady: string;
  services: string;
  limit: number;
}): Promise<string> {
  await Promise.all([
    mkdir(join(home, 'data/asi-sense'), { recursive: true, mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(
    join(home, 'data/asi-sense/settings.json'),
    JSON.stringify({
      version: 1,
      paused: false,
      sendTitles: false,
      rules: [
        ...DEFAULT_RULES,
        ...defaultBodyRules(),
        {
          id: 'e2e-agent-file',
          match: { kind: 'file.changed', subject: `${workspace}/**` },
          level: process.env.ASI_E2E_ONLY_TARGET === '1' ? 'context' : 'wake',
          createdBy: 'user',
          approved: true,
        },
      ],
      disabled: [],
    }),
    { mode: 0o600 },
  );
  const overlay = join(root, 'overlay.yml');
  await writeFile(
    overlay,
    `- id: llm-pi-ai
  config:
    providers:
      magpie:
        displayName: Local test gateway
        apiKeyEnv: ASI_MAGPIE_PLACEHOLDER
        api: openai-completions
        baseURL: http://127.0.0.1:3425/v1
        retryPolicy:
          mode: normal
          maxRetries: 0
        models:
          - id: auto/gpt-6.1-sol
            name: Local test model
- id: agent-default-model
  config:
    provider: magpie
    model: auto/gpt-6.1-sol
- id: session-persistence-jsonl
  config:
    root: ${JSON.stringify(sessionRoot)}
    compression: none
- id: workspace-controller
  config:
    documentsDirectory: ${JSON.stringify(root)}
- id: tool-bash
  disabled: false
- id: tool-jobs
  config:
    completionDelivery: quiet
- id: session-title-llm
  disabled: true
- id: session-telemetry-otel
  disabled: true
- id: desktop-product-telemetry
  disabled: true
- id: product-analytics
  disabled: true
- id: message-feedback
  disabled: true
- id: ui-message-feedback
  disabled: true
- id: command-feedback
  disabled: true
- insert:
    - id: asi-sense-e2e-budget
      name: asi-sense-e2e-budget
      config:
        counter: ${JSON.stringify(counter)}
        ready: ${JSON.stringify(budgetReady)}
        services: ${JSON.stringify(services)}
        limit: ${limit}
`,
    { mode: 0o600 },
  );
  return overlay;
}
