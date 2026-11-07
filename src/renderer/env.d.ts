import type { ClicklessAPI } from '../shared/ipc';

declare global {
  interface Window {
    clickless: ClicklessAPI;
  }
}
export {};
