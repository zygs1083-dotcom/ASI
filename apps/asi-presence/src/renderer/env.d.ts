/// <reference types="vite/client" />
import type { AsiPresenceBridgeApi } from '../shared/ipc-api.ts';

declare global {
  interface Window {
    asiPresence?: AsiPresenceBridgeApi;
  }
}
