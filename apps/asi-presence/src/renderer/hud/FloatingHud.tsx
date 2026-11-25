import { useCallback, useEffect, useRef, useState } from 'react';
import type { AsiPresenceBridgeApi, PresenceAppState } from '../../shared/ipc-api.ts';
import type { PresenceSceneEngine } from '../stage/presence-scene.ts';

interface FloatingHudProps {
  api: AsiPresenceBridgeApi;
  state: PresenceAppState;
  companionName: string;
  canvasHostRef: React.RefObject<HTMLDivElement>;
  sceneRef: React.MutableRefObject<PresenceSceneEngine | null>;
  vadBackend: string;
  vadRms: number;
  isSpeaking: boolean;
  onSendMessage: (text: string) => void;
  onToggleMic: () => void;
  onInterrupt: () => void;
}

const EMOTION_LABELS: Record<PresenceAppState['emotion'], string> = {
  calm: '平静陪伴',
  focused: '安静护航',
  joyful: '开心摇尾',
  affectionate: '温暖贴近',
  thinking: '专注思索',
  alert: '警觉提醒',
  tired: '节能休憩',
};

export function FloatingHud({
  api,
  state,
  companionName,
  canvasHostRef,
  sceneRef,
  vadRms,
  isSpeaking,
  onSendMessage,
  onToggleMic,
  onInterrupt,
}: FloatingHudProps) {
  const [hovered, setHovered] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const draggingRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
    active: false,
    lastX: 0,
    lastY: 0,
  });
  const ignoringRef = useRef<boolean>(true);

  const setIgnore = useCallback(
    (ignore: boolean) => {
      if (ignoringRef.current === ignore) return;
      ignoringRef.current = ignore;
      api.setIgnoreMouseEvents(ignore);
    },
    [api],
  );

  useEffect(() => {
    if (inputOpen) {
      setIgnore(false);
      inputRef.current?.focus();
    }
  }, [inputOpen, setIgnore]);

  useEffect(() => {
    const evaluatePointer = (clientX: number, clientY: number, target: EventTarget | null) => {
      const nx = (clientX / Math.max(1, window.innerWidth)) * 2 - 1;
      const ny = -((clientY / Math.max(1, window.innerHeight)) * 2 - 1);
      sceneRef.current?.setPointerNormalized(nx, ny);

      let overInteractiveDom = false;
      const el = target instanceof HTMLElement ? target : null;
      if (el?.closest('.floating-dock, .floating-status-pill, .floating-subtitle')) {
        overInteractiveDom = true;
      } else if (typeof document.elementsFromPoint === 'function') {
        const stack = document.elementsFromPoint(clientX, clientY);
        overInteractiveDom = stack.some((node) =>
          node instanceof HTMLElement
            ? Boolean(node.closest('.floating-dock, .floating-status-pill, .floating-subtitle'))
            : false,
        );
      }
      const overAvatar = sceneRef.current?.isPointInsideAvatarRadius(clientX, clientY) ?? false;
      const interactive = overInteractiveDom || overAvatar || inputOpen;
      setHovered(interactive);
      setIgnore(!interactive);
    };

    const handleMove = (ev: MouseEvent | PointerEvent) => {
      if (draggingRef.current.active) {
        const dx = ev.screenX - draggingRef.current.lastX;
        const dy = ev.screenY - draggingRef.current.lastY;
        draggingRef.current.lastX = ev.screenX;
        draggingRef.current.lastY = ev.screenY;
        if (dx !== 0 || dy !== 0) {
          api.dragFloatingWindow(dx, dy);
        }
        return;
      }
      evaluatePointer(ev.clientX, ev.clientY, ev.target);
    };

    const stopDrag = () => {
      draggingRef.current.active = false;
    };

    const onMouseLeave = () => {
      if (!draggingRef.current.active && !inputOpen) {
        setHovered(false);
        setIgnore(true);
      }
    };

    // Listen to BOTH mousemove and pointermove: Electron `setIgnoreMouseEvents(true, { forward: true })`
    // on macOS reliably forwards `mousemove` even while click-through is engaged.
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    window.addEventListener('mouseup', stopDrag);
    window.addEventListener('blur', stopDrag);
    document.addEventListener('mouseleave', onMouseLeave);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      window.removeEventListener('mouseup', stopDrag);
      window.removeEventListener('blur', stopDrag);
      document.removeEventListener('mouseleave', onMouseLeave);
    };
  }, [api, inputOpen, sceneRef, setIgnore]);

  const handleCanvasPointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return;
    if (sceneRef.current?.isPointInsideAvatarRadius(ev.clientX, ev.clientY)) {
      draggingRef.current = { active: true, lastX: ev.screenX, lastY: ev.screenY };
      setIgnore(false);
      try {
        ev.currentTarget.setPointerCapture(ev.pointerId);
      } catch {
        // Ignore if pointer capture is unavailable
      }
    }
  };

  const latestAssistant = [...state.messages].reverse().find((m) => m.role === 'assistant');
  const showSubtitle =
    !state.bridge.tom.shouldDefer &&
    Boolean(latestAssistant?.text) &&
    (isSpeaking || latestAssistant?.streaming || hovered);

  const handleSubmit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const clean = draft.trim();
    if (!clean) return;
    setDraft('');
    onSendMessage(clean);
  };

  return (
    <div className="floating-root" data-theme={state.theme}>
      <div
        ref={canvasHostRef}
        role="application"
        aria-label="雪儿悬浮全息形象"
        className="floating-canvas-host"
        onPointerDown={handleCanvasPointerDown}
        onDoubleClick={() => void api.setWindowMode('stage')}
      />

      <div className="floating-status-pill">
        <span
          className={`led ${state.privacy.physicalKillSwitch ? 'danger' : state.bridge.connected ? 'on' : 'warn'}`}
        />
        <strong>{companionName}</strong>
        <span style={{ color: 'var(--text-secondary)' }}>
          {state.bridge.tom.shouldDefer ? '静默护航中' : EMOTION_LABELS[state.emotion]}
        </span>
      </div>

      {showSubtitle && latestAssistant && (
        <div className="floating-subtitle">
          {latestAssistant.text.slice(0, 110)}
          {latestAssistant.text.length > 110 ? '…' : ''}
        </div>
      )}

      <div
        className="floating-dock"
        style={{ opacity: hovered || inputOpen || isSpeaking || state.privacy.microphoneEnabled ? 1 : 0.88 }}
      >
        {state.privacy.microphoneEnabled && !state.privacy.physicalKillSwitch && (
          <div className="vad-meter-track" style={{ width: 160 }}>
            <div className="vad-meter-fill" style={{ width: `${Math.min(100, Math.round(vadRms * 100))}%` }} />
          </div>
        )}

        {inputOpen && (
          <form className="floating-input-row" onSubmit={handleSubmit}>
            <input
              ref={inputRef}
              type="text"
              placeholder={`跟${companionName}说点什么…`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className="btn btn-primary btn-icon">
              发送
            </button>
          </form>
        )}

        <div className="floating-toolbar">
          <button
            type="button"
            className="btn btn-icon"
            title="切换雪儿形象（核心 / Q版 / 真人）"
            onClick={() => void api.toggleAvatarForm()}
          >
            {state.form === 'jarvis-core' ? '◉ 核心' : state.form === 'chibi' ? '🐾 Q版' : '✨ 真人'}
          </button>

          {state.form !== 'jarvis-core' && (
            <button
              type="button"
              className={`btn btn-icon ${state.particleMode ? 'btn-primary' : ''}`}
              title="切换粒子形态 / 实体形象 (Cmd+Shift+M)"
              onClick={() => void api.toggleParticleMode()}
            >
              {state.particleMode ? '❖ 实体' : '✦ 粒子'}
            </button>
          )}

          <button
            type="button"
            className={`btn btn-icon ${state.privacy.microphoneEnabled ? 'btn-primary' : ''}`}
            title="语音聆听与 Silero VAD 开口打断"
            onClick={onToggleMic}
          >
            {state.privacy.microphoneEnabled ? '🎙 聆听中' : '🎙 语音'}
          </button>

          {isSpeaking ? (
            <button type="button" className="btn btn-danger btn-icon" onClick={onInterrupt}>
              ⏹ 打断
            </button>
          ) : (
            <button
              type="button"
              className={`btn btn-icon ${inputOpen ? 'btn-primary' : ''}`}
              onClick={() => setInputOpen((v) => !v)}
            >
              💬
            </button>
          )}

          <button
            type="button"
            className="btn btn-icon"
            title="展开全息舞台控制台 (Cmd+Shift+A)"
            onClick={() => void api.setWindowMode('stage')}
          >
            ⤢ 舞台
          </button>
        </div>
      </div>
    </div>
  );
}
