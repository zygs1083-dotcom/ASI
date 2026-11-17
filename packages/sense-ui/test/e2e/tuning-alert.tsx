import { createRoot } from 'react-dom/client';
import { makeScenario } from '../../src/mock/scenarios';
import { SensePanel } from '../../src/SensePanel';
import '../../src/preview/preview.css';

const model = makeScenario('rebaseline-suggested');
let resolve: () => void;
let reject: () => void;
let rejectSuggestion: () => void;
window.addEventListener('test-resolve', () => resolve());
window.addEventListener('test-reject', () => reject());
window.addEventListener('test-reject-suggestion', () => rejectSuggestion());
const pending = () =>
  new Promise<void>((done, fail) => {
    resolve = done;
    reject = () => fail(new Error('test failure'));
  });
const pendingSuggestion = () =>
  new Promise<void>((_, fail) => {
    rejectSuggestion = () => fail(new Error('test failure'));
  });

createRoot(document.getElementById('root')!).render(
  <main className="stage">
    <SensePanel
      model={model}
      onToggleRule={() => {}}
      onConfirmRule={() => {}}
      onDeleteRule={() => {}}
      onPause={() => {}}
      onToggleTitles={() => {}}
      onOpenPermissionSettings={() => {}}
      onRevertTuning={() => {}}
      onLockParam={() => {}}
      onFeedback={() => {}}
      onResumeTuning={pending}
      onResetTuning={pending}
      onAcceptRebaseline={pendingSuggestion}
    />
  </main>,
);
