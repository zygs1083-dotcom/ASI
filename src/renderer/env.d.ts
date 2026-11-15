import type { AsiApi } from '../shared/types';

declare global {
  interface Window {
    asi: AsiApi;
  }
}
