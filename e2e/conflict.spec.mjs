/*
 * conflict.spec.mjs — REQ-VCS-009: divergence requires an explicit decision.
 *
 * This is the test the version-control design is arranged around. Two people edit one file, both
 * export, and one of the exports is opened beside a browser that has moved on. The requirement is not
 * "merge them well" — it is that nothing is merged at all until a person says so (ADR-0003). So the
 * assertions are mostly about what has *not* happened: no commit written, no history rewritten, the
 * working copy untouched by a view the user merely looked at.
 *
 * "Nothing happened" leaves no trace on screen, which is what makes this hard to test from the
 * interface. The trace is the file: a native export carries the working history as it stands, so
 * exporting before and after the comparison and reading the two says exactly what the comparison did.
 * Reaching into `TMV.shell`'s state instead would have been easier and would pass on a build where the
 * comparison was never rendered — which is the failure mode worth catching.
 */

import fs from 'node:fs';

import { test, expect } from '@playwright/test';

import { e2eTest } from '../test/lib/check.mjs';
import { artifactText, fileTarget } from './fixtures.mjs';
import {
  acceptAndMerge,
  addEntity,
  commit,
  compareView,
  containerOf,
  exportToFile,
  goSection,
  isDirty,
  loggedCommitIds,
  openArtifact,
} from './shell.mjs';

const short = (id) => String(id).replace(/^sha256:/, '').slice(0, 7);

/** The commits a native export carries, and the head it is at. */
function nativeHistory(file) {
  const container = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    head: container.history.head,
    ids: container.history.commits.map((c) => c.id),
    count: container.history.commits.length,
  };
}

test.describe('a diverged file', () => {
  test(e2eTest('e2e.conflict.prompt'), async ({ browser }) => {
    test.setTimeout(300000);
    const target = fileTarget(artifactText());
    const dir = target.dir;

    // --- two people, one file ---------------------------------------------------------------------
    //
    // Each side edits in a context of its own, because storage is per origin and per path
    // (`05-storage.md` §4): a second context is what "another browser" actually means here, and a
    // second tab would share the first one's store so the histories would never diverge.

    const mine = await browser.newContext();
    const myPage = await mine.newPage();
    await openArtifact(myPage, target.url);
    await goSection(myPage, 'architecture', 'components');
    await addEntity(myPage, 'components', { Name: 'Payments API', Type: 'process' });
    await commit(myPage, 'Add the payments API');
    const start = await exportToFile(myPage, 'html', dir, 'start.html');

    const theirs = await browser.newContext();
    const theirPage = await theirs.newPage();
    await openArtifact(theirPage, target.urlOf(start.name));
    await goSection(theirPage, 'architecture', 'components');
    await addEntity(theirPage, 'components', { Name: 'Ledger', Type: 'process' });
    await commit(theirPage, 'Add the ledger');
    const theirExport = await exportToFile(theirPage, 'html', dir, 'theirs.html');
    // The bytes are kept as they were at the moment of export, so that later assertions about "the file
    // on disk was not rewritten" compare against something rather than re-reading the same file twice.
    const theirBytes = fs.readFileSync(theirExport.path, 'utf8');
    const theirContainer = containerOf(theirBytes);
    await theirs.close();

    // The first profile moves on independently, so the two histories now share a root and nothing
    // else — the shape REQ-VCS-009 exists for.
    await goSection(myPage, 'architecture', 'components');
    await addEntity(myPage, 'components', { Name: 'Reporting', Type: 'process' });
    await commit(myPage, 'Add the reporting job');

    const before = nativeHistory((await exportToFile(myPage, 'native', dir, 'before.json')).path);
    const theirIds = theirContainer.history.commits.map((c) => c.id);
    const theirHead = theirContainer.history.head;
    const union = Array.from(new Set(before.ids.concat(theirIds))).sort();

    // The precondition the rest of the test rests on: the two sides genuinely diverged. If one head
    // were an ancestor of the other this would be a fast-forward, the shell would not open the compare
    // view at all, and every "nothing happened" assertion below would pass for the wrong reason.
    expect(theirHead, 'the two sides are at the same commit, so there is nothing to reconcile').not.toBe(
      before.head,
    );
    expect(before.ids, 'the file’s head is an ancestor of this browser’s, so this is not a divergence').not.toContain(
      theirHead,
    );
    expect(theirIds, 'this browser’s head is on the file’s history, so this is not a divergence').not.toContain(
      before.head,
    );
    expect(
      union.length,
      'this browser has no commit the file does not already carry, so it has nothing to contribute',
    ).toBeGreaterThan(theirIds.length);

    // --- AC1: opening it shows a compare view naming both heads -----------------------------------

    await openArtifact(myPage, target.urlOf(theirExport.name));
    const compare = await compareView(myPage);
    const compareText = await compare.innerText();
    const wholeView = await myPage.locator('#tmv-content').innerText();
    expect(wholeView, 'the compare view is not the section that was rendered').toMatch(/Compare\s*&\s*Merge/);
    expect(
      wholeView,
      'the comparison does not say it was opened by the file rather than by the user',
    ).toContain('diverged');
    expect(compareText, 'the compare view does not name this browser’s head').toContain(short(before.head));
    expect(
      wholeView,
      'the compare view does not name the head the file arrived with',
    ).toContain(short(theirHead));
    expect(
      compareText,
      'the compare view names the heads but does not say that nothing was written',
    ).toMatch(/written/i);

    // --- AC2: no commit was written by the act of opening the file ---------------------------------
    //
    // The working head is still the one this browser had, and the commit set is exactly the union of
    // the two sides — which is what the screen needs to show a comparison at all. The assertion that
    // carries AC2 is the *exactness*: a merge commit would be an id belonging to neither side, so an
    // id set larger than the union is the signature of an automatic merge, and a head that is not this
    // browser's head is the signature of the same thing.

    const afterOpen = nativeHistory((await exportToFile(myPage, 'native', dir, 'after-open.json')).path);
    expect(
      afterOpen.head,
      'opening a diverged file moved the working head, so something was committed without being asked',
    ).toBe(before.head);
    expect(
      afterOpen.ids.slice().sort(),
      'the commit set after opening is not exactly the two sides put together',
    ).toEqual(union);

    // --- AC3: dismissing leaves the working copy and both histories unchanged -----------------------
    //
    // The comparison is opened again rather than reused: exporting navigated to the Export screen, which
    // took the compare view off the page. The *comparison* is still open — it is shell state, and only
    // dismissing or merging clears it — but the nodes are gone, and a locator that no longer resolves
    // would have waited out the whole test. Re-entering the section is also what a person does after
    // going to look at the export.

    const reopened = await compareView(myPage);
    const wasDirty = await isDirty(myPage);
    await reopened.locator('[data-action="cancel"]').click();
    await expect(
      myPage.locator('#tmv-notifications'),
      'dismissing the comparison was not acknowledged',
    ).toContainText(/comparison dismissed/i);
    await expect(
      myPage.locator('#tmv-content .tmv-compare-host'),
      'the comparison is still on screen after being dismissed',
    ).toHaveCount(0);

    const afterCancel = nativeHistory((await exportToFile(myPage, 'native', dir, 'after-cancel.json')).path);
    expect(afterCancel.head, 'dismissing the comparison moved the working head').toBe(before.head);
    expect(afterCancel.ids, 'dismissing the comparison changed the commit set').toEqual(afterOpen.ids);
    expect(await isDirty(myPage), 'dismissing the comparison changed the working copy').toBe(wasDirty);

    // AC3 says dismissing leaves *both* histories unchanged, and one of the two is a file on disk.
    // Reading it back is the only honest way to say that: the application reads it as text and never
    // writes to it, so the bytes are still the bytes it was exported with and still at its own head —
    // which is not this browser's head, so nothing was quietly brought into line either.
    const theirBytesNow = fs.readFileSync(theirExport.path, 'utf8');
    expect(theirBytesNow, 'the file that was opened is not the file that was exported').toBe(theirBytes);
    expect(containerOf(theirBytesNow).history.head, 'the file on disk no longer holds its own head').toBe(
      theirHead,
    );
    expect(afterCancel.head, 'the two histories were reconciled by dismissing the comparison').not.toBe(
      theirHead,
    );

    // --- and confirming is what changes any of it ---------------------------------------------------
    //
    // The other half of AC2, asserted so the test cannot pass by the merge being broken: the same
    // screen, with the suggestions accepted, does write a commit. A test that only proved nothing
    // happens would pass on an application that never merges anything at all.

    await openArtifact(myPage, target.urlOf(theirExport.name));
    await compareView(myPage);
    await acceptAndMerge(myPage, 'Merge the ledger and reporting work');
    expect(
      await myPage.locator('#tmv-notifications').innerText(),
      'the merge was not acknowledged',
    ).toMatch(/merg/i);

    const merged = nativeHistory((await exportToFile(myPage, 'native', dir, 'merged.json')).path);
    expect(merged.head, 'confirming a resolution did not write a merge commit').not.toBe(before.head);
    expect(merged.count, 'the merge did not add exactly one commit').toBe(union.length + 1);
    expect(merged.ids, 'the merge lost commits that were on screen').toEqual(expect.arrayContaining(union));
    expect(merged.head, 'the merge commit is not the new head').toBe(
      merged.ids.filter((id) => !union.includes(id))[0],
    );
    expect(await isDirty(myPage), 'the working copy is dirty straight after a merge').toBe(false);
    expect(
      (await loggedCommitIds(myPage)).length,
      'the History log does not list the merged history',
    ).toBeGreaterThan(0);

    await mine.close();
  });
});
