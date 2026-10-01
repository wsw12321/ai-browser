import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Run the gateway's opt-in TestBrowserHandoffBrowserFixture on port 4180 first.
export default defineConfig({
  ...base,
  testMatch: 'handoff-cross-origin.spec.ts',
  fullyParallel: false,
  workers: 1,
  use: { ...base.use, baseURL: 'http://127.0.0.1:4174' },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4174 --strictPort',
    env: { VITE_GATEWAY_URL: 'http://127.0.0.1:4180' },
    url: 'http://127.0.0.1:4174',
    timeout: 30000,
    reuseExistingServer: false,
  },
});
