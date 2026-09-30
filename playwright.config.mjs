/*
 * playwright.config.mjs — the runner for the end-to-end layer (`09-testing.md` §2, §4).
 *
 * Three things about this file are load-bearing.
 *
 * 1. **`testDir` is `./e2e`, not `./test/e2e`.** `node --test` with no path arguments imports every
 *    `.mjs` under any directory named `test`, so a Playwright spec in there is loaded outside its own
 *    runner, where `@playwright/test` throws "Playwright Test did not expect test() to be called
 *    here" and takes the whole Node run down with it. The e2e specs are therefore outside that tree
 *    and `npm test` never sees them.
 *
 * 2. **`testMatch` is `.spec.mjs` and nothing else.** `e2e/fixtures.mjs`, `e2e/shell.mjs`,
 *    `e2e/journey.mjs` and `e2e/serve.mjs` are support modules with no tests in them; the default
 *    Playwright pattern would try to run them.
 *
 * 3. **One worker.** Each spec drives a real browser against a ~1.5 MB artifact, and several of them
 *    write export files and start a static server. The suite is ten tests; running them serially
 *    costs a few minutes and removes a class of flake that has nothing to do with the application.
 *
 * `browserName` is chromium here, but that is the *default* browser rather than the only one.
 * `e2e.matrix.browser` and `e2e.file-protocol.firefox` launch the other engines themselves, because
 * what they assert is a property of a specific engine and a project matrix would run every spec
 * against every engine, including the specs whose subject is protocol rather than browser.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.mjs$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180000,
  expect: { timeout: 15000 },
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    // Downloads are how `REQ-EXP-012` is checked, and the assertion is about the file's contents —
    // so the download has to be accepted and saved somewhere the test can read it.
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  },
});
