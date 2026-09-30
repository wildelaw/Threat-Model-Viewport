/*
 * matrix.spec.mjs — REQ-SHELL-004 and REQ-SHELL-005, the two requirements that are about the
 * *matrix* rather than about a feature.
 *
 * REQ-SHELL-004 says the application functions identically from `file://` and over HTTP, "except where
 * platform storage rules differ — and where they differ, it shall say so in the UI". That is two
 * claims and they need two different tests. The first is behavioural and is met by running §4's core
 * journey twice, once per scheme, and comparing what the two runs observed. The second is a claim
 * about disclosure, and it is met by reading what the interface says about storage in each scheme —
 * because the way this requirement fails is not that the app stops working over `file://`, it is that
 * it works differently there and says nothing.
 *
 * REQ-SHELL-005 is the browser half: the support matrix stated in About, and a runtime capability
 * check with a defined fallback. Both are asserted against the real artifact in every engine that
 * will start in this environment, and the engines that will not are reported rather than passed over.
 */

import { chromium, firefox, webkit, test, expect } from '@playwright/test';

import { e2eTest } from '../test/lib/check.mjs';
import { artifactText, fileTarget, protocolMatrix } from './fixtures.mjs';
import { runCoreJourney } from './journey.mjs';
import { goSection, openArtifact } from './shell.mjs';

/** The storage caveat the shell states from a file on disk, and the one it states over HTTP. */
const FILE_CAVEAT = 'one storage area';
const WEB_CAVEAT = 'stored by this browser for the site it was opened from';

/** What the About panel says about browsers, verbatim from `18-views-settings.js`. */
const SUPPORT_MATRIX = [
  'The current and previous major versions of Chrome, Edge, Firefox and Safari are supported.',
  'Chrome and Edge give every local file one shared storage area',
  'Firefox since version 92 gives each file path its own',
  'Safari is restrictive and inconsistent',
];

test.describe('the protocol matrix', () => {
  test(e2eTest('e2e.matrix.protocol'), async ({ browser }) => {
    test.setTimeout(600000);
    // §4's core journey, on both protocols, from one artifact text. The two runs are compared rather
    // than merely both performed: "functions identically" is a claim about the difference between
    // them, and two green runs of a journey that took different paths would not support it.
    const targets = await protocolMatrix(artifactText());
    try {
      const notes = [];
      const file = await runCoreJourney({ browser, target: targets.file, log: notes });
      const http = await runCoreJourney({ browser, target: targets.http, log: notes });

      // The journeys are compared by name and by position, and the second run has one step the first
      // cannot: the two profiles reconcile in the same order, so the step lists must be equal.
      const names = (report) => report.steps.map((s) => s.step);
      expect(
        names(http),
        'the two protocols took different journeys: ' + JSON.stringify(names(http)) + ' vs ' + JSON.stringify(names(file)),
      ).toEqual(names(file));

      // Both runs reached a real merge with both sides reachable — the end state, not just the steps.
      for (const [kind, report] of [['file', file], ['http', http]]) {
        expect(report.headBefore, `${kind}: the journey did not record a starting head`).toBeTruthy();
        expect(report.headAfter, `${kind}: the journey did not reach a merged head`).toBeTruthy();
        expect(report.headAfter, `${kind}: the head did not move`).not.toBe(report.headBefore);
      }

      // --- the exception, stated in the UI -------------------------------------------------------
      //
      // REQ-SHELL-004 concedes exactly one difference and requires it to be disclosed. Over `file://`
      // the shell states the local-file storage caveat as a persistent banner (REQ-STORE-007); over
      // HTTP there is no such banner, because every visit to that origin shares one store and there is
      // nothing surprising to say. The About panel's "What applies to this session" line says the
      // matching sentence in both cases, which is where the claim actually lands.

      const fileContext = await browser.newContext();
      const filePage = await fileContext.newPage();
      await openArtifact(filePage, targets.file.url);
      const fileBanner = await filePage.locator('#tmv-banners').innerText();
      expect(
        fileBanner,
        'opened from disk, the application does not say how disk storage behaves',
      ).toContain(FILE_CAVEAT);
      await goSection(filePage, 'settings', 'about');
      expect(
        await filePage.locator('#tmv-content').innerText(),
        'the About panel does not describe this session’s storage on the file protocol',
      ).toContain('This file is open from disk');
      await fileContext.close();

      const httpContext = await browser.newContext();
      const httpPage = await httpContext.newPage();
      await openArtifact(httpPage, targets.http.url);
      const httpBanner = await httpPage.locator('#tmv-banners').innerText();
      expect(
        httpBanner,
        'the file-protocol caveat is stated on a page where it is not true',
      ).not.toContain(FILE_CAVEAT);
      await goSection(httpPage, 'settings', 'about');
      expect(
        await httpPage.locator('#tmv-content').innerText(),
        'served over HTTP, the About panel does not say where this model is stored',
      ).toContain(WEB_CAVEAT);
      await httpContext.close();
    } finally {
      await targets.close();
    }
  });
});

test.describe('the browser matrix', () => {
  test(e2eTest('e2e.matrix.browser'), async ({ browser }) => {
    test.setTimeout(300000);
    const target = fileTarget(artifactText());

    // --- the support matrix, as stated -----------------------------------------------------------

    const checked = [];
    const skipped = [];
    for (const [name, type] of [
      ['chromium', chromium],
      ['webkit', webkit],
      ['firefox', firefox],
    ]) {
      let engine = null;
      try {
        engine = await type.launch();
      } catch (error) {
        // Reported, never silent. A suite that quietly ran one engine and claimed the matrix would
        // be making the claim REQ-SHELL-005 asks for on the strength of a third of the evidence.
        skipped.push(`${name}: ${String(error.message).split('\n')[0]}`);
        continue;
      }
      try {
        const context = await engine.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        await openArtifact(page, target.url);
        await goSection(page, 'settings', 'about');
        const about = await page.locator('#tmv-content').innerText();
        for (const statement of SUPPORT_MATRIX) {
          expect(about, `${name}: the About panel does not state "${statement}"`).toContain(statement);
        }
        // The `file://` caveat has to name the consequence, not just the behaviour: a matrix that
        // lists browsers and stops there is exactly what the AC's second clause rules out.
        expect(
          about,
          `${name}: the About panel does not say what the storage difference costs the reader`,
        ).toContain('a file that is moved, renamed or copied may not find history that an earlier copy of it stored');

        // The session line is a runtime capability check made visible: it is different in different
        // environments because it is *read*, not assumed. This build is open from disk in every engine
        // here, and the line says so rather than saying nothing.
        expect(
          about,
          `${name}: the About panel has no runtime statement about this session`,
        ).toContain('What applies to this session:');
        checked.push(name);
        await context.close();
      } finally {
        await engine.close();
      }
    }

    expect(
      checked.length,
      `no engine would start, so the support matrix is unverified: ${skipped.join('; ')}`,
    ).toBeGreaterThan(0);
    test.info().annotations.push({
      type: 'engines',
      description: `checked ${checked.join(', ')}${skipped.length ? `; skipped ${skipped.join('; ')}` : ''}`,
    });

    // --- the build record is readable where it exists ---------------------------------------------
    //
    // The other half of the same panel, and the one place the *page* can be checked against the
    // *file*: the About panel reads its build record out of the document's own meta elements. On a
    // page that has them it must report them, and it must report them as agreeing — the claim
    // ADR-0008's honesty rules allow, because it is a page checking itself against what it declares.
    const buildContext = await browser.newContext();
    const buildPage = await buildContext.newPage();
    await openArtifact(buildPage, target.url);
    await goSection(buildPage, 'settings', 'about');
    const build = await buildPage.locator('#tmv-content').innerText();
    expect(build, 'the About panel reports no build time for a file that records one').not.toContain('not recorded');
    expect(build, 'the About panel reports no declared hash for a file that carries one').not.toContain('not stated');
    expect(build, 'the About panel does not name the declared code hash').toMatch(/Declared code hash\s*sha256-/);
    expect(build, 'the two hashes this page can compare are not reported as agreeing').toContain('The two agree');
    await buildContext.close();

    // --- a capability check with a defined fallback -----------------------------------------------
    //
    // REQ-SHELL-005 AC2. The capability that matters most here is storage, and the check is a *write*
    // probe rather than a presence probe: Safari's private mode has a `localStorage` that exists and
    // throws on the first write. Blocking the getter outright is the same shape of failure, and the
    // fallback is defined: the model stays in memory, the banner says so, and the work can still be
    // exported. A page that threw here would be a page that lost the model.
    const blocked = await browser.newContext();
    await blocked.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('storage is blocked for this test');
        },
      });
    });
    const blockedPage = await blocked.newPage();
    await openArtifact(blockedPage, target.url);
    const banner = await blockedPage.locator('#tmv-banners').innerText();
    expect(banner, 'nothing on screen says storage was refused').toMatch(/not be kept|not be saved|not saving/i);
    expect(
      await blockedPage.locator('#tmv-content h1.tmv-view__title').count(),
      'the application did not render a view with storage unavailable',
    ).toBeGreaterThan(0);
    expect(
      await blockedPage.locator('#tmv-side-nav-items [data-action="side-nav"]').count(),
      'the shell did not mount with storage unavailable',
    ).toBeGreaterThan(0);
    await blocked.close();
  });
});
