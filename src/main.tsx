import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';
import {initApiClient, isNativeAndroidApp} from './lib/apiClient';

if (!isNativeAndroidApp()) {
  registerSW({immediate: true});
}

function isEditableTouchTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, [contenteditable="true"], .select-text'));
}

if (typeof document !== 'undefined') {
  document.addEventListener('dragstart', (event) => {
    if (!isEditableTouchTarget(event.target)) {
      event.preventDefault();
    }
  });

  document.addEventListener('contextmenu', (event) => {
    const isTouchEnv =
      isNativeAndroidApp() ||
      (typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches);
    if (isTouchEnv && !isEditableTouchTarget(event.target)) {
      event.preventDefault();
    }
  });
}

void initApiClient().finally(() => {
  createRoot(document.getElementById('root')!).render(<App />);
});
