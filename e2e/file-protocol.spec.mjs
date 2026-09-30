/*
 * file-protocol.spec.mjs — REQ-SHELL-002 and REQ-SYNC-008, the two requirements that only exist because
 * the artifact is opened from disk.
 *
 * REQ-SHELL-002 is the reason there is no build step and no module system in the shipped file: an
 * opaque origin blocks `<script type="module">` with a relative `src`, so the application is one
 * classic inline script. That is a constraint on the *artifact*, and the unit suite already checks the
 * bytes (`shell.classic-script`). What it cannot check is the half of the AC that matters — "loads and
 * runs when opened via `file://`" — because "runs" is a fact about a browser, not about a string. So
 * this file opens the artifact from disk and checks that the application came up: the shell mounted,
 * the tabs rendered, the embedded history was read, and navigation works.
 *
 * REQ-SYNC-008 is the disclosure that goes with the one platform difference the design concedes.
 * Firefox gives every `file://` path its own storage area since version 92, so the same file moved
 * house cannot see what it saved before. The application may not claim to know this — it is a
 * heuristic, and `07-storage.js` says so — but it must *offer it*, in plain language, with the
 * file-based path alongside. That is what the Firefox half of this file asserts, and it is the only
 * test in the suite that requires Firefox: the whole point is that the notice appears because the
 * browser is Firefox, and a stub that says `isFirefox: true` would be testing the branch rather than
 * the behaviour.
 */

import { firefox, test, expect } from '@playwright/test';

import { e2eTest } from '../test/lib/check.mjs';
import { artifactText, fileTarget } from './fixtures.mjs';
import { dataBlockOf, goSection, goTab, heading, loggedCommitIds, openArtifact, openModelName, sectionTitle } from './shell.mjs';

test.describe('opened from disk', () => {
  test(e2eTest('e2e.file-protocol.bootstrap'), async ({ browser }) => {
    const target = fileTarget(artifactText());
    const context = await browser.newContext();
    const page = await context.newPage();

    const failures = [];
    page.on('pageerror', (error) => failures.push(String(error && error.message)));
    await openArtifact(page, target.url);

    // --- the script that did this is a classic inline script ------------------------------------

    const scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script')).map((node) => ({
        id: node.getAttribute('id'),
        type: node.getAttribute('type'),
        src: node.getAttribute('src'),
        // A script element with no `src` and a JavaScript type is a candidate to run; the data block
        // is `application/json`, which is not executable and never will be, so it is not counted here.
        executable:
          !node.getAttribute('src') &&
          (node.getAttribute('type') === null || /javascript|module/i.test(node.getAttribute('type'))),
      })),
    );
    expect(
      scripts.filter((s) => s.type === 'module'),
      'a module script is present; `file://` blocks a relative one and this file must not depend on it',
    ).toEqual([]);
    for (const script of scripts.filter((s) => s.src)) {
      expect(script.src, 'a script with a non-absolute src cannot load from an opaque origin').toMatch(/^https:\/\//);
    }
    // Exactly one inline script, and it is the application. An inline script that is not the hashed
    // one cannot run under this policy, so a file that grew a second one would stop booting — and a
    // page that ran two would be running code the CSP hash does not cover.
    const inline = scripts.filter((s) => s.executable);
    expect(
      inline.map((s) => s.id),
      'the artifact does not carry exactly one executable inline script',
    ).toEqual(['tmv-app']);
    expect(failures, 'the application threw while booting from disk: ' + failures.join(' | ')).toEqual([]);

    // --- and it is running, not merely loaded ---------------------------------------------------

    expect(
      await page.locator('#tmv-tabs [role="tab"]').count(),
      'the shell did not render its tabs, so the script did not run',
    ).toBeGreaterThanOrEqual(9);
    expect(
      await page.locator('#tmv-side-nav-items [data-action="side-nav"]').count(),
      'the side nav is empty, so the shell did not mount',
    ).toBeGreaterThan(0);

    // The embedded model is on screen, which is the proof that the data block was parsed rather than
    // merely present — the block is what the whole single-file design stores its content in.
    const block = dataBlockOf(artifactText());
    expect(await openModelName(page), 'the switcher is not showing the embedded model').toBe(block.model.name);

    // The shell's own history view is reading the same block: the commit the artifact ships with is
    // the only one, and it is the head.
    const log = await loggedCommitIds(page);
    expect(log, 'the History log does not list the commit the file carries').toEqual([block.history.head]);
    expect(block.history.commits.length, 'the artifact ships without a history to read').toBe(1);

    // Navigation works, which is what separates "rendered one screen" from "running". The tab's own
    // label is the `h1`; the section underneath draws its own title, and both are checked so that
    // "the side nav switched section" is not inferred from "the tab switched".
    await goTab(page, 'threats');
    expect(await heading(page)).toBe('Threats');
    await goSection(page, 'settings', 'about');
    expect(await heading(page)).toBe('Settings');
    expect(await sectionTitle(page)).toBe('About');

    await context.close();
  });
});

test.describe('Firefox, from disk', () => {
  test(e2eTest('e2e.file-protocol.firefox'), async () => {
    // Launched explicitly rather than taken from the fixture, because the point of the test is which
    // browser it is: the notice under test is the one the application shows *because* the engine
    // partitions `file://` storage per path.
    let engine = null;
    try {
      engine = await firefox.launch();
    } catch (error) {
      test.skip(
        true,
        'this environment cannot launch Firefox, so the partitioned-storage notice is not verifiable ' +
          'here; `sync.partition-detected` covers the same branch in the unit harness. ' +
          String(error.message).split('\n')[0],
      );
      return;
    }

    try {
      const target = fileTarget(artifactText());
      // A clean profile: the heuristic is "an empty registry on a first run", so a context that has
      // seen this file before would be testing a different branch.
      const context = await engine.newContext();
      const page = await context.newPage();
      await openArtifact(page, target.url);

      // --- AC1: the explanation names per-file origin partitioning ------------------------------

      const banner = await page.locator('#tmv-banners').innerText();
      expect(banner, 'Firefox from disk produced no storage notice at all').toMatch(/storage|remember/i);
      expect(
        banner,
        'the notice does not name the browser behaviour: ' + banner.replace(/\s+/g, ' ').slice(0, 300),
      ).toContain('separate storage area for each local file path');
      expect(banner, 'the notice does not name Firefox').toContain('Firefox');
      expect(
        banner,
        'the notice does not say what it costs the reader: a moved or renamed file',
      ).toMatch(/moved, renamed or copied/);

      // It is offered as a likely explanation rather than as a finding — the detection is a heuristic
      // and `07-storage.js` carries `certain: false`, so the wording has to leave room for that.
      expect(
        banner,
        'the notice claims certainty about something that is a guess',
      ).toMatch(/may keep its own storage|no history was found/i);

      // --- AC2: the file-based path is offered alongside ------------------------------------------

      expect(
        banner,
        'the notice names the partitioning but not the way round it',
      ).toMatch(/exporting a new copy is the reliable way to carry work between paths|file-based/i);
      // A notification's actions all carry `data-action="notify-action"` and name *which* one in
      // `data-value` — the component owns "a click landed on one of my actions" and the shell branches
      // on the value, which is the same shape toasts use. Addressed by the action's own name the
      // locator matched nothing, and the count assertion below would have failed on it; it never ran,
      // because the banner assertion above failed first. One defect stood in front of the other, which
      // is how a selector that could never match survived on a case that had never once passed.
      const offer = page.locator('#tmv-banners [data-action="notify-action"][data-value="export-now"]');
      expect(
        await offer.count(),
        'the notice offers no action, so the workaround is a sentence rather than a route',
      ).toBeGreaterThan(0);
      await expect(offer.first()).toBeVisible();
      await expect(offer.first()).toContainText(/export a copy/i);

      // The same explanation reaches the About panel's session line, where a reader who dismissed the
      // banner can find it again.
      await goSection(page, 'settings', 'about');
      const about = await page.locator('#tmv-content').innerText();
      expect(
        about,
        'the About panel does not carry the same explanation for this session',
      ).toContain('separate storage area for each local file path');

      await context.close();
    } finally {
      await engine.close();
    }
  });
});
