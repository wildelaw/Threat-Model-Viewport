/*
 * export.spec.mjs — REQ-EXP-007, REQ-EXP-012 and REQ-SEC-001, against the built artifact.
 *
 * These three requirements are the ones that cannot be checked anywhere except in a browser, and the
 * reason is the same for all of them: they are claims about what a *file* does when a browser opens
 * it. A unit test can prove that the export function returns a string with the right pieces in it. It
 * cannot prove that the string is a working application — that it boots from `file://`, that its
 * security policy still matches the script the concatenating build produced, or that the text shown
 * in the fallback block is the whole file rather than a rendering of it.
 *
 * The tampered-script test is the one worth reading first. It is the only test in the suite that
 * asserts a *failure* is the correct outcome, and it needs a control beside it: the same page, with
 * one byte changed, must stop working, and the unmodified one must still work. Without the control the
 * test would pass on a file that never worked at all.
 */

import fs from 'node:fs';

import { test, expect } from '@playwright/test';

import { e2eTest } from '../test/lib/check.mjs';
import { artifactText, fileTarget, fileUrlOf, makeWorkdir, writeFile } from './fixtures.mjs';
import {
  addEntity,
  commit,
  containerOf,
  exportToFile,
  goSection,
  heading,
  loggedCommitIds,
  openArtifact,
  openModelName,
  settle,
} from './shell.mjs';

/** Short form of a commit id, the way the interface writes one. */
const short = (id) => String(id).replace(/^sha256:/, '').slice(0, 7);

const openTag = '<' + 'script';
const closeTag = '</' + 'script>';

test.describe('export', () => {
  test(e2eTest('e2e.export.self-contained'), async ({ browser }) => {
    // REQ-EXP-007: the export is the application plus the model plus the *whole* history, and it opens
    // standalone at the exported head. One test, four claims, all of them read off the produced file
    // rather than off the page that produced it.
    const target = fileTarget(artifactText());
    const context = await browser.newContext();
    const page = await context.newPage();
    await openArtifact(page, target.url);

    await goSection(page, 'architecture', 'components');
    await addEntity(page, 'components', { Name: 'Ledger service', Type: 'process' });
    await commit(page, 'Add the ledger service');

    await goSection(page, 'history', 'log');
    const logBefore = await loggedCommitIds(page);
    const headBefore = logBefore[0];

    const exported = await exportToFile(page, 'html', target.dir, 'self-contained.html');
    const text = fs.readFileSync(exported.path, 'utf8');

    // --- the file is the application -------------------------------------------------------------
    //
    // Not "looks like HTML": the app script, the pinned policy and the data block are the three parts
    // that make it runnable, and an export missing any of them would still parse as a document.
    expect(text.toLowerCase(), 'the export is not an HTML document').toContain('<!doctype html');
    const block = containerOf(text);
    expect(
      text.includes(`id="tmv-data"`),
      'the export carries no embedded data block, so it is not an application',
    ).toBe(true);
    expect(
      text.indexOf('http-equiv="Content-Security-Policy"') < text.indexOf(openTag),
      'the export must carry its policy before any script it governs',
    ).toBe(true);
    expect(block.build && block.build.appHash, 'the export does not record which build produced it').toBeTruthy();

    // --- it carries the edit, at the head that was exported --------------------------------------
    expect(
      block.model.components.map((c) => c.name),
      'the exported model is missing the committed edit',
    ).toContain('Ledger service');
    expect(short(block.history.head), 'the export is not at the head the history view showed').toBe(
      short(headBefore),
    );

    // --- and the full history, not only the head -------------------------------------------------
    //
    // AC2 in as many words. The count is the check that matters: an export carrying only the head
    // would have one commit, and the root commit's own message is the proof that it reaches the
    // beginning rather than stopping at the first keyframe.
    expect(
      block.history.commits.length,
      `the export carries ${block.history.commits.length} commits, the log lists ${logBefore.length}`,
    ).toBe(logBefore.length);
    expect(
      block.history.commits.map((c) => c.message),
      'the export does not reach the root commit',
    ).toContain(`Create ${block.model.name}`);

    // --- it opens standalone ----------------------------------------------------------------------
    //
    // A second, clean context, and the file opened from disk with no server and no shared storage —
    // which is the state a person hands the file over in.
    const clean = await browser.newContext();
    const exportedPage = await clean.newPage();
    await openArtifact(exportedPage, fileUrlOf(target.dir, exported.name));
    expect(await openModelName(exportedPage), 'the exported file opened under a different model').toBe(
      block.model.name,
    );
    await goSection(exportedPage, 'architecture', 'components');
    expect(
      await exportedPage.locator('#tmv-content tbody tr').count(),
      'the exported file opened without the components it was exported with',
    ).toBeGreaterThan(0);
    const logAfter = await loggedCommitIds(exportedPage);
    expect(logAfter[0], 'the exported file did not open at the exported head').toBe(block.history.head);
    expect(logAfter.length, 'the exported file does not carry the whole history').toBe(
      block.history.commits.length,
    );

    await clean.close();
    await context.close();
  });

  test(e2eTest('e2e.export.file-protocol'), async ({ browser }) => {
    // REQ-EXP-012: under `file://` export either downloads or, where the browser refuses, shows the
    // full content so it can be saved by hand. Both halves are accepted and both are checked for
    // *completeness* — a fallback that showed a truncated file would satisfy the letter of the AC and
    // none of its purpose.
    const target = fileTarget(artifactText());
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await openArtifact(page, target.url);

    await goSection(page, 'architecture', 'components');
    await addEntity(page, 'components', { Name: 'Signing service', Type: 'process' });
    await commit(page, 'Add the signing service');

    const exported = await exportToFile(page, 'html', target.dir, 'from-file-protocol.html');
    expect(
      ['download', 'fallback'],
      `the export took neither route (${exported.method})`,
    ).toContain(exported.method);

    const text = fs.readFileSync(exported.path, 'utf8');
    // The artifact is over a megabyte, so "the whole file" is a claim with a number behind it. A
    // fallback that wrote only what fits on screen would fail here by three orders of magnitude.
    expect(text.length, `the ${exported.method} produced ${text.length} bytes, which is not the app`).toBeGreaterThan(
      500000,
    );
    expect(text.toLowerCase()).toContain('<!doctype html');
    expect(text.includes('id="tmv-app"'), 'the produced file carries no application script').toBe(true);
    expect(text.includes('id="tmv-data"'), 'the produced file carries no embedded model').toBe(true);
    expect(containerOf(text).model.components.map((c) => c.name)).toContain('Signing service');

    // The proof that it is complete is that it runs: the produced bytes are opened from disk in a
    // clean context, which is exactly what a person does with the file they just saved.
    const clean = await browser.newContext();
    const reopened = await clean.newPage();
    await openArtifact(reopened, fileUrlOf(target.dir, exported.name));
    expect(await heading(reopened), 'the saved copy did not open as an application').toBeTruthy();
    await goSection(reopened, 'architecture', 'components');
    expect(
      await reopened.locator('#tmv-content tbody tr').count(),
      'the saved copy opened without the model',
    ).toBeGreaterThan(0);

    await clean.close();
    await context.close();
  });
});

test.describe('the security policy on a file from disk', () => {
  test(e2eTest('e2e.csp.tampered-script-blocked'), async ({ browser }) => {
    // REQ-SEC-001, all three ACs. AC2 is a property of the bytes; AC1 and AC3 are properties of a
    // browser's behaviour, and both are asserted by watching what the browser says it refused rather
    // than by inferring it from a page that failed to appear for some other reason.
    const original = artifactText();
    const dir = makeWorkdir('tmv-e2e-csp-');

    // --- AC2: the policy is delivered before the first script it governs ------------------------

    const policyAt = original.indexOf('http-equiv="Content-Security-Policy"');
    const firstScriptAt = original.indexOf(openTag);
    expect(policyAt, 'the export carries no CSP meta element').toBeGreaterThan(-1);
    expect(firstScriptAt, 'the export carries no script element').toBeGreaterThan(-1);
    expect(policyAt, 'the policy comes after the first script, so it governs nothing').toBeLessThan(firstScriptAt);
    expect(
      /script-src[^;]*'sha256-/.test(original),
      'the policy does not pin the application script by hash',
    ).toBe(true);

    // --- the control: the untampered file boots -------------------------------------------------

    const control = fileTarget(original);
    const controlContext = await browser.newContext();
    const controlPage = await controlContext.newPage();
    await openArtifact(controlPage, control.url);
    expect(
      await controlPage.locator('#tmv-tabs [role="tab"]').count(),
      'the untampered artifact does not boot, so this test proves nothing about tampering',
    ).toBeGreaterThanOrEqual(9);
    await controlContext.close();

    // --- AC1: modifying the application script makes the browser refuse it ----------------------
    //
    // The mutation is a comment appended to the end of the application script's own body. It is
    // deliberately a *valid* change: the script would run perfectly if the browser allowed it, so a
    // page that fails to appear cannot be explained by a syntax error. The only thing that changed is
    // the bytes, and the only thing that cares about the bytes is the hash.

    const appAt = original.indexOf('<script id="tmv-app"');
    expect(appAt, 'the artifact has no application script to tamper with').toBeGreaterThan(-1);
    const appEnd = original.indexOf(closeTag, appAt);
    expect(appEnd, 'the application script is not closed').toBeGreaterThan(appAt);
    const tampered =
      original.slice(0, appEnd) + '\n/* tampered by e2e.csp.tampered-script-blocked */\n' + original.slice(appEnd);

    writeFile(dir, 'tampered.html', tampered);
    const refused = [];
    const tamperedContext = await browser.newContext();
    const tamperedPage = await tamperedContext.newPage();
    tamperedPage.on('console', (message) => refused.push(message.text()));
    tamperedPage.on('pageerror', (error) => refused.push(String(error && error.message)));
    await tamperedPage.goto(fileUrlOf(dir, 'tampered.html'), { waitUntil: 'load' });
    await tamperedPage.waitForTimeout(500);

    expect(
      refused.join('\n'),
      'the browser did not report refusing the modified script: ' + refused.join(' | '),
    ).toMatch(/Content Security Policy|Refused to execute inline script/i);
    expect(
      await tamperedPage.locator('#tmv-tabs [role="tab"]').count(),
      'the shell mounted from a script whose hash no longer matches the policy',
    ).toBe(0);
    await tamperedContext.close();

    // --- AC3: an unexpected remote script is blocked --------------------------------------------

    const injected =
      original.slice(0, original.indexOf('</body>')) +
      '<' +
      'script src="https://example.invalid/tmv-probe.js"></' +
      'script>' +
      original.slice(original.indexOf('</body>'));

    writeFile(dir, 'injected.html', injected);
    const violations = [];
    const injectedContext = await browser.newContext();
    const injectedPage = await injectedContext.newPage();
    injectedPage.on('console', (message) => violations.push(message.text()));
    await injectedPage.goto(fileUrlOf(dir, 'injected.html'), { waitUntil: 'load' });
    await settle(injectedPage);
    await injectedPage.waitForTimeout(500);

    expect(
      violations.join('\n'),
      'the browser did not report blocking the injected script: ' + violations.join(' | '),
    ).toMatch(/example\.invalid\/tmv-probe\.js/);
    expect(
      violations.join('\n'),
      'the injected script was reported as something other than a policy violation',
    ).toMatch(/Content Security Policy|Refused to load the script/i);
    // The application itself is unaffected: the policy is narrow enough to block a stranger and
    // exactly wide enough to run the file it was pinned to.
    expect(
      await injectedPage.locator('#tmv-tabs [role="tab"]').count(),
      'the policy blocked the application along with the injected script',
    ).toBeGreaterThanOrEqual(9);
    await injectedContext.close();
  });
});
