export const DELIVERABLE_KINDS: ReadonlySet<string> = new Set(
  [
    'app.activated app.launched app.terminated window.focused window.title-changed file.changed file.burst',
    'file.activity job.started job.exited job.failed process.started process.exited source.status source.error',
    'body.threshold body.rate body.anomaly system.sleep system.wake screen.locked screen.unlocked',
    'session.active session.inactive away.summary delivery.target-unavailable',
  ].flatMap((s) => s.split(' ')),
);

export const MODEL_RULE_KINDS: ReadonlySet<string> = new Set([...DELIVERABLE_KINDS, 'fact.updated']);

export const KNOWN_EVENT_KINDS: ReadonlySet<string> = new Set([...MODEL_RULE_KINDS, 'delivery-unknown']);
