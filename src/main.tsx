import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';
import {initApiClient, isNativeAndroidApp} from './lib/apiClient';

if (!isNativeAndroidApp()) {
  registerSW({immediate: true});
}

void initApiClient().finally(() => {
  createRoot(document.getElementById('root')!).render(<App />);
});
