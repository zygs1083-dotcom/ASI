/**
 * Theory of Mind (`src/tom/`) runtime coordinator.
 *
 * Connects L0 sensory signals (`ctx.asiSense`) and ordinary DSH conversation
 * dynamics to the zero-token ToM evaluator, registers the silent Tier-3
 * `asi-tom:social_tact` Maslow drive (`autoMaintain: false`), and exposes
 * calibration actions + `TomPanelModel` + `AsiTomServiceApi` snapshots.
 */

import type { PartnerStateSnapshot, SenseSnapshot } from '@asi/sense-types';
import { factStatusAt } from '@asi/sense-types';
import { ASI_INTERNAL_SESSION_ID_RE } from '../../shared/internal-guards.js';
import {
  PARTNER_STATE_KINDS,
  type PartnerOverrideInput,
  type PartnerStateKind,
  type TactGuidance,
  type TomPanelModel,
} from '../shared/types.js';
import {
  applyManualCalibration,
  classifyFrontApp,
  createZeroCalibrationBiases,
  DEFAULT_RAPPORT_BASELINE,
  evaluatePartnerState,
  type TomApprovalObservation,
  type TomAppSwitchObservation,
  type TomEvaluationResult,
  type TomFrictionObservation,
  type TomHysteresisAnchor,
  type TomPromptObservation,
  type TomReliefObservation,
  updateBaselineWithApproval,
  updateBaselineWithPrompt,
  updateBaselineWithSwitchWindow,
} from './evaluator.js';
import type { TomHostPorts } from './ports.js';
import { createDefaultPersistedTomState, type PersistedTomState, TomStateStore } from './storage.js';

const MAX_EVENT_WINDOW = 64;
const MAX_SEEN_SIGNAL_IDS = 512;
const MAX_SESSION_PROMPT_TRACKERS = 256;
const EVENT_RETENTION_MS = 30 * 60_000;
const DEFAULT_OVERRIDE_MINUTES = 60;
const DEFAULT_TICK_MS = 30_000;

export interface PartnerPreferenceHint {
  title: string;
  content: string;
  retention: number;
  pinned: boolean;
}

export interface PartnerToolReport {
  now: number;
  enabled: boolean;
  paused: boolean;
  state: PartnerStateKind;
  source: PartnerStateSnapshot['source'];
  confidence: number;
  dimensions: PartnerStateSnapshot['dimensions'];
  guidance: TactGuidance;
  reasons: string[];
  manualOverride: PartnerStateSnapshot['manualOverride'];
  baseline?: PartnerStateSnapshot['baseline'];
  consolidatedPreferences?: PartnerPreferenceHint[];
}

export interface TomRuntimeOptions {
  tickIntervalMs?: number;
}

export interface TomActionsApi {
  setEnabled(enabled: boolean): Promise<void>;
  setManualOverride(input: PartnerOverrideInput): Promise<TomPanelModel>;
  resetBaseline(): Promise<TomPanelModel>;
}

export function createTomRuntime(ports: TomHostPorts, options?: TomRuntimeOptions) {
  const nowFn = ports.now ?? (() => Date.now());
  const store = new TomStateStore(ports.storageRoot);

  let persisted: PersistedTomState = createDefaultPersistedTomState(nowFn());
  let started = false;
  let stopped = false;

  const prompts: TomPromptObservation[] = [];
  const frictions: TomFrictionObservation[] = [];
  const reliefs: TomReliefObservation[] = [];
  const approvals: TomApprovalObservation[] = [];
  const appSwitches: TomAppSwitchObservation[] = [];
  const lastPromptAtBySession = new Map<string, number>();

  const seenSignalQueue: string[] = [];
  const seenSignalSet = new Set<string>();

  let lastUnlockAt: number | undefined;
  let lastSwitchBaselineSampleAt = 0;
  let anchor: TomHysteresisAnchor | undefined;
  let cachedEval: TomEvaluationResult | undefined;

  const listeners = new Set<(snapshot: PartnerStateSnapshot) => void>();
  const disposers: (() => void)[] = [];
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  function markSignalSeen(id: string): boolean {
    if (seenSignalSet.has(id)) return false;
    seenSignalSet.add(id);
    seenSignalQueue.push(id);
    if (seenSignalQueue.length > MAX_SEEN_SIGNAL_IDS) {
      const oldest = seenSignalQueue.shift();
      if (oldest) seenSignalSet.delete(oldest);
    }
    return true;
  }

  function pruneWindow<T extends { at: number }>(list: T[], currentNow: number): void {
    const cutoff = currentNow - EVENT_RETENTION_MS;
    while (list.length > 0 && (list.length > MAX_EVENT_WINDOW || (list[0]?.at ?? 0) < cutoff)) {
      list.shift();
    }
  }

  function pruneAllWindows(currentNow: number): void {
    pruneWindow(prompts, currentNow);
    pruneWindow(frictions, currentNow);
    pruneWindow(reliefs, currentNow);
    pruneWindow(approvals, currentNow);
    pruneWindow(appSwitches, currentNow);
  }

  function schedulePersist(): void {
    if (stopped) return;
    if (saveTimer !== undefined) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      persisted.lastUpdatedAt = nowFn();
      void store.save(persisted).catch(() => undefined);
    }, 600);
    saveTimer.unref?.();
  }

  async function persistNow(): Promise<void> {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    persisted.lastUpdatedAt = nowFn();
    await store.save(persisted);
  }

  function ingestRecentSignals(currentNow: number, sensePaused = ports.sense.snapshot().settings.paused): boolean {
    if (!persisted.enabled || sensePaused) return false;
    let mutated = false;
    const signals = ports.sense.recentSignals();
    for (const sig of signals) {
      if (!sig?.id || !markSignalSeen(sig.id)) continue;
      const at = typeof sig.at === 'number' && Number.isFinite(sig.at) ? sig.at : currentNow;
      if (currentNow - at > EVENT_RETENTION_MS) continue;

      if (sig.kind === 'app.activated') {
        const data = sig.data ?? {};
        const name = typeof data.name === 'string' ? data.name : undefined;
        const bundleId = typeof data.bundleId === 'string' ? data.bundleId : undefined;
        appSwitches.push({ at, category: classifyFrontApp(name, bundleId) });
        mutated = true;
      } else if (sig.kind === 'screen.unlocked' || sig.kind === 'system.wake') {
        lastUnlockAt = Math.max(lastUnlockAt ?? 0, at);
        mutated = true;
      } else if (sig.kind === 'job.exited') {
        const exitCode = typeof sig.data?.exitCode === 'number' ? sig.data.exitCode : undefined;
        const owner = typeof sig.data?.sessionId === 'string' ? sig.data.sessionId : sig.subject;
        const isInternal = typeof owner === 'string' && ASI_INTERNAL_SESSION_ID_RE.test(owner);
        if (!isInternal && exitCode !== undefined) {
          if (exitCode !== 0) {
            frictions.push({ at, kind: 'command_failed' });
          } else {
            reliefs.push({ at, kind: 'command_succeeded' });
          }
          mutated = true;
        }
      }
    }
    return mutated;
  }

  function computeEvaluation(senseSnap?: SenseSnapshot): TomEvaluationResult {
    const snap = senseSnap ?? ports.sense.snapshot();
    const currentNow = nowFn();
    ingestRecentSignals(currentNow, snap.settings.paused);
    pruneAllWindows(currentNow);

    // Clear expired manual override automatically
    if (persisted.manualOverride && currentNow >= persisted.manualOverride.expiresAt) {
      persisted = { ...persisted, manualOverride: null };
      schedulePersist();
    }

    const sysFact = snap.state.env.system;
    const sysOk = sysFact && factStatusAt(sysFact, snap.now) === 'ok' ? sysFact.value : null;
    const screenLocked = Boolean(sysOk?.locked);
    const systemSleeping = Boolean(
      sysOk?.lastSleepAt !== undefined && (sysOk.lastWakeAt === undefined || sysOk.lastSleepAt > sysOk.lastWakeAt),
    );

    // Sample 5-minute app switch rate into baseline during active unlocked sessions
    if (
      started &&
      !snap.settings.paused &&
      persisted.enabled &&
      !screenLocked &&
      !systemSleeping &&
      currentNow - lastSwitchBaselineSampleAt >= 300_000
    ) {
      lastSwitchBaselineSampleAt = currentNow;
      const count5m = appSwitches.filter((s) => currentNow - s.at <= 300_000).length;
      persisted = {
        ...persisted,
        baseline: updateBaselineWithSwitchWindow(persisted.baseline, count5m),
      };
      schedulePersist();
    }

    const frontFact = snap.state.env.frontApp;
    const frontOk = frontFact && factStatusAt(frontFact, snap.now) === 'ok' ? frontFact.value : null;
    const frontAppCategory = frontOk ? classifyFrontApp(frontOk.name, frontOk.bundleId) : null;

    const result = evaluatePartnerState({
      now: currentNow,
      enabled: persisted.enabled,
      sensePaused: snap.settings.paused,
      screenLocked,
      systemSleeping,
      ...(lastUnlockAt !== undefined ? { lastUnlockAt } : {}),
      frontAppCategory,
      hasActiveOrdinarySession: Boolean(snap.activeSessionId) || ports.sessions.hasActiveOrdinarySession(),
      prompts,
      frictions,
      reliefs,
      approvals,
      appSwitches,
      baseline: persisted.baseline,
      calibrationBiases: persisted.calibrationBiases,
      calibrationCount: persisted.calibrationCount,
      manualOverride: persisted.manualOverride,
      ...(anchor ? { previousInferred: anchor } : {}),
    });

    anchor = result.nextAnchor;
    cachedEval = result;
    return result;
  }

  function toSnapshot(evalResult?: TomEvaluationResult): PartnerStateSnapshot {
    const res = evalResult ?? computeEvaluation();
    const currentNow = nowFn();
    return {
      now: currentNow,
      enabled: persisted.enabled,
      paused: res.source === 'paused',
      state: res.state,
      source: res.source,
      confidence: res.confidence,
      dimensions: { ...res.dimensions },
      guidance: {
        ...res.guidance,
        directives: [...res.guidance.directives],
      },
      reasons: [...res.reasons],
      manualOverride: persisted.manualOverride ? { ...persisted.manualOverride } : null,
      baseline: { ...res.baselineSummary },
      updatedAt: currentNow,
    };
  }

  function toPanelModel(evalResult?: TomEvaluationResult): TomPanelModel {
    const res = evalResult ?? computeEvaluation();
    const senseSnap = ports.sense.snapshot();
    const drivesSnap = ports.drives?.snapshot();
    const registeredDrive = drivesSnap?.drives.find((d) => d.key === 'asi-tom:social_tact');

    return {
      now: nowFn(),
      enabled: persisted.enabled,
      sensePaused: senseSnap.settings.paused,
      state: res.state,
      source: res.source,
      confidence: res.confidence,
      dimensions: { ...res.dimensions },
      guidance: {
        ...res.guidance,
        directives: [...res.guidance.directives],
      },
      reasons: [...res.reasons],
      manualOverride: persisted.manualOverride ? { ...persisted.manualOverride } : null,
      baseline: { ...res.baselineSummary },
      driveSatisfaction: registeredDrive?.satisfaction ?? res.driveReading.satisfaction,
      driveZone: registeredDrive?.zone ?? res.driveZone,
      suppressed: registeredDrive?.suppressed ?? Boolean(drivesSnap?.higherOrderSuppressed),
    };
  }

  function emitToListeners(snap: PartnerStateSnapshot): void {
    for (const listener of [...listeners]) {
      try {
        listener(snap);
      } catch {
        // Isolate subscriber error
      }
    }
  }

  function notifyAll(reconcileDrives = true): void {
    if (stopped) return;
    const res = computeEvaluation();
    if (reconcileDrives) {
      ports.drives?.notifySourceChanged('asi-tom');
    }
    emitToListeners(toSnapshot(res));
  }

  const actions: TomActionsApi = {
    async setEnabled(enabled: boolean): Promise<void> {
      persisted = {
        ...persisted,
        enabled: Boolean(enabled),
      };
      await persistNow();
      notifyAll(true);
    },

    async setManualOverride(input: PartnerOverrideInput): Promise<TomPanelModel> {
      const currentNow = nowFn();
      const currentEval = cachedEval ?? computeEvaluation();

      if (input.state === null) {
        persisted = {
          ...persisted,
          manualOverride: null,
        };
      } else {
        if (!(PARTNER_STATE_KINDS as readonly string[]).includes(input.state)) {
          throw new Error('无效的搭档状态枚举');
        }
        const durationMins =
          typeof input.durationMinutes === 'number' && Number.isFinite(input.durationMinutes)
            ? Math.min(480, Math.max(5, Math.round(input.durationMinutes)))
            : DEFAULT_OVERRIDE_MINUTES;

        const calibrated = applyManualCalibration(
          persisted.calibrationBiases,
          persisted.calibrationCount,
          currentEval.inferredState,
          input.state,
        );

        persisted = {
          ...persisted,
          calibrationBiases: calibrated.biases,
          calibrationCount: calibrated.calibrationCount,
          manualOverride: {
            state: input.state,
            setAt: currentNow,
            expiresAt: currentNow + durationMins * 60_000,
          },
        };
      }

      await persistNow();
      notifyAll(true);
      return toPanelModel();
    },

    async resetBaseline(): Promise<TomPanelModel> {
      persisted = {
        ...persisted,
        manualOverride: null,
        baseline: { ...DEFAULT_RAPPORT_BASELINE },
        calibrationBiases: createZeroCalibrationBiases(),
        calibrationCount: 0,
      };
      await persistNow();
      notifyAll(true);
      return toPanelModel();
    },
  };

  return {
    actions,

    async start(): Promise<void> {
      if (started) return;
      persisted = await store.load(nowFn());
      lastSwitchBaselineSampleAt = nowFn();
      started = true;

      computeEvaluation();

      if (ports.drives) {
        disposers.push(
          ports.drives.registerSource({
            id: 'asi-tom',
            tier: 3,
            label: '搭档状态感知与协作眼力见',
            evaluate: (senseSnap) => [computeEvaluation(senseSnap).driveReading],
          }),
        );
        disposers.push(
          ports.drives.subscribe(() => {
            emitToListeners(toSnapshot(cachedEval));
          }),
        );
      }

      disposers.push(
        ports.sense.subscribe((senseSnap) => {
          const prevState = cachedEval?.state;
          const prevFriction = cachedEval?.dimensions.friction ?? 0;
          const prevFocus = cachedEval?.dimensions.focus ?? 0;
          const prevSource = cachedEval?.source;
          const next = computeEvaluation(senseSnap);
          const meaningfulChange =
            next.state !== prevState ||
            next.source !== prevSource ||
            Math.abs(next.dimensions.friction - prevFriction) >= 4 ||
            Math.abs(next.dimensions.focus - prevFocus) >= 5;
          if (meaningfulChange) {
            ports.drives?.notifySourceChanged('asi-tom');
            emitToListeners(toSnapshot(next));
          }
        }),
      );

      disposers.push(
        ports.sessions.onUserPrompt((sig) => {
          if (!persisted.enabled || ports.sense.snapshot().settings.paused) return;
          const prevAt = lastPromptAtBySession.get(sig.sessionId);
          const interMessageMs = prevAt !== undefined && sig.at >= prevAt ? sig.at - prevAt : undefined;
          if (lastPromptAtBySession.has(sig.sessionId)) {
            lastPromptAtBySession.delete(sig.sessionId);
          }
          lastPromptAtBySession.set(sig.sessionId, sig.at);
          while (lastPromptAtBySession.size > MAX_SESSION_PROMPT_TRACKERS) {
            const oldest = lastPromptAtBySession.keys().next().value;
            if (oldest === undefined) break;
            lastPromptAtBySession.delete(oldest);
          }

          prompts.push({
            at: sig.at,
            charCount: sig.charCount,
            ...(interMessageMs !== undefined ? { interMessageMs } : {}),
          });
          persisted = {
            ...persisted,
            baseline: updateBaselineWithPrompt(persisted.baseline, {
              charCount: sig.charCount,
              ...(interMessageMs !== undefined ? { interMessageMs } : {}),
            }),
          };
          schedulePersist();
          notifyAll(true);
        }),
      );

      disposers.push(
        ports.sessions.onTurnSettled((sig) => {
          if (!persisted.enabled || ports.sense.snapshot().settings.paused) return;
          if (sig.outcome === 'interrupted') {
            frictions.push({ at: sig.at, kind: 'user_interrupt' });
          } else if (sig.outcome === 'aborted') {
            frictions.push({ at: sig.at, kind: 'turn_aborted' });
          } else if (sig.outcome === 'error') {
            frictions.push({ at: sig.at, kind: 'turn_error' });
          } else if (sig.outcome === 'completed') {
            reliefs.push({ at: sig.at, kind: 'turn_completed' });
          }
          notifyAll(true);
        }),
      );

      disposers.push(
        ports.sessions.onApprovalResolved((sig) => {
          if (!persisted.enabled || ports.sense.snapshot().settings.paused) return;
          approvals.push({ at: sig.at, latencyMs: sig.latencyMs });
          persisted = {
            ...persisted,
            baseline: updateBaselineWithApproval(persisted.baseline, sig.latencyMs),
          };
          schedulePersist();
          notifyAll(true);
        }),
      );

      if (ports.sleep) {
        disposers.push(
          ports.sleep.subscribe(() => {
            emitToListeners(toSnapshot(cachedEval));
          }),
        );
      }

      const tickMs = Math.max(1_000, options?.tickIntervalMs ?? DEFAULT_TICK_MS);
      tickTimer = setInterval(() => {
        notifyAll(true);
      }, tickMs);
      tickTimer.unref?.();
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (tickTimer !== undefined) {
        clearInterval(tickTimer);
        tickTimer = undefined;
      }
      const hadPendingSave = saveTimer !== undefined;
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      for (const off of disposers.splice(0).reverse()) {
        try {
          off();
        } catch {
          // ignore
        }
      }
      listeners.clear();
      lastPromptAtBySession.clear();
      seenSignalSet.clear();
      seenSignalQueue.length = 0;
      if (started && hadPendingSave) {
        await store.save({ ...persisted, lastUpdatedAt: nowFn() }).catch(() => undefined);
      }
      await store.flush();
    },

    snapshot(): PartnerStateSnapshot {
      return toSnapshot();
    },

    tactGuidance(): TactGuidance {
      return toSnapshot().guidance;
    },

    shouldDeferProactiveWork(): boolean {
      const snap = toSnapshot();
      return !snap.paused && (snap.state === 'deep_focus' || snap.state === 'rapid_sprint');
    },

    panelModel(): TomPanelModel {
      return toPanelModel();
    },

    toolReport(opts?: { includePreferences?: boolean; includeBaseline?: boolean }): PartnerToolReport {
      const snap = toSnapshot();
      const includePreferences = opts?.includePreferences !== false;
      const includeBaseline = opts?.includeBaseline === true;

      let consolidatedPreferences: PartnerPreferenceHint[] | undefined;
      if (includePreferences && ports.sleep) {
        const memories = ports.sleep.listMemories({
          kinds: ['preference'],
          minRetention: 0.45,
          limit: 5,
        });
        if (memories.length > 0) {
          consolidatedPreferences = memories.map((m) => ({
            title: m.title,
            content: m.content,
            retention: Math.round(m.retention * 100) / 100,
            pinned: m.pinned,
          }));
        }
      }

      return {
        now: snap.now,
        enabled: snap.enabled,
        paused: snap.paused,
        state: snap.state,
        source: snap.source,
        confidence: snap.confidence,
        dimensions: snap.dimensions,
        guidance: snap.guidance,
        reasons: snap.reasons,
        manualOverride: snap.manualOverride,
        ...(includeBaseline ? { baseline: snap.baseline } : {}),
        ...(consolidatedPreferences ? { consolidatedPreferences } : {}),
      };
    },

    subscribe(listener: (snapshot: PartnerStateSnapshot) => void): () => void {
      if (stopped) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type TomRuntime = ReturnType<typeof createTomRuntime>;
