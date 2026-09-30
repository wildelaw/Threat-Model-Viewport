/*
 * journey.mjs — the core journey from `09-testing.md` §4, in one place.
 *
 * §4 specifies one end-to-end path and then says `e2e.matrix.protocol` runs it "on both protocols".
 * That sentence is why this is a module rather than the body of a spec: two copies of a fifteen-step
 * journey would drift, and the way they would drift is that one of them would quietly stop covering a
 * step. Running the same function twice, once per scheme, is the only version of "passes on both
 * protocols" that means anything.
 *
 * The path as written in §4 is:
 *
 *     open file → view model → edit → commit → export HTML → reopen export in a clean profile →
 *     reconcile → edit → export → import into the first profile → compare → merge
 *
 * Two steps are realised differently here from how a first reading suggests, and both differences
 * are the application's own design rather than a shortcut:
 *
 * 1. **"reopen export in a clean profile"** is a second browser context, not a second tab. Storage is
 *    per origin and per file path (`05-storage.md` §4), so a second context is what "clean profile"
 *    actually means to the application; a second tab would share the first one's storage and the step
 *    would prove nothing.
 *
 * 2. **"import into the first profile → compare → merge"** splits in two, because the import screen
 *    and the reconcile path answer this question differently and the spec requires both answers.
 *    Importing a container that names a model this browser already has raises REQ-IMP-006's prompt —
 *    replace or import as a new model, and *nothing is merged either way*, which the prompt says in
 *    as many words. The comparison and the merge belong to REQ-SYNC-005 and REQ-VCS-009, which route
 *    a *file whose history has diverged* to the compare view on open. So the journey does both: it
 *    imports the second export and asserts the prompt, then opens it and merges. A journey that only
 *    did the second would be skipping the step §4 names; one that only did the first would never
 *    reach the merge.
 *
 * The journey returns a report of what each step observed. The spec asserts on it; nothing is
 * asserted here, so that a failure names the step that produced it rather than "the journey failed".
 */

import {
  acceptAndMerge,
  dataBlockOf,
  addEntity,
  commit,
  compareView,
  containerOf,
  exportToFile,
  goSection,
  goTab,
  heading,
  importFile,
  importPrompt,
  isDirty,
  loggedCommitIds,
  openArtifact,
  openModelName,
  rowCount,
} from './shell.mjs';

/** The tabs and their headings, as `17-shell.js` declares them. */
const TABS = [
  ['overview', 'Overview'],
  ['architecture', 'Architecture'],
  ['data', 'Data'],
  ['flows', 'Flows'],
  ['threats', 'Threats'],
  ['risk', 'Risk'],
  ['controls', 'Controls'],
  ['history', 'History'],
  ['settings', 'Settings'],
];

/**
 * Run §4's path once, against one protocol.
 *
 * `target` is a `fileTarget`/`serveCopy` handle: `url` is where the artifact is, `urlOf(name)` is
 * where a file written into its directory will be, and `dir` is where exports land.
 */
export async function runCoreJourney({ browser, target, log }) {
  const report = { protocol: target.kind, steps: [] };
  const note = (step, detail) => {
    report.steps.push({ step, detail });
    if (log) log.push(`${target.kind}: ${step} — ${detail}`);
  };

  // --- profile one ------------------------------------------------------------------------------

  const first = await browser.newContext();
  const page = await first.newPage();
  await openArtifact(page, target.url);

  // --- view the model ---------------------------------------------------------------------------

  const opened = await openModelName(page);
  const headings = [];
  for (const [tab, label] of TABS) {
    await goTab(page, tab);
    headings.push([tab, await heading(page), label]);
  }
  const wrongHeadings = headings.filter(([, actual, expected]) => actual !== expected);
  if (wrongHeadings.length) {
    throw new Error('a tab did not render its own view: ' + JSON.stringify(wrongHeadings));
  }
  note('view', `${headings.length} tabs rendered; the open model is ${JSON.stringify(opened)}`);

  // --- edit -------------------------------------------------------------------------------------

  await goSection(page, 'architecture', 'components');
  const beforeRows = await rowCount(page);
  await addEntity(page, 'components', { Name: 'Payment API', Type: 'process' });
  const afterRows = await rowCount(page);
  if (afterRows <= beforeRows) throw new Error('adding a component did not add a row');
  const dirtyAfterEdit = await isDirty(page);
  if (!dirtyAfterEdit) throw new Error('an edit did not mark the working copy as having changes');
  note('edit', `components ${beforeRows} → ${afterRows}; the header reports uncommitted changes`);

  // --- commit -----------------------------------------------------------------------------------

  await commit(page, 'Add the payment API component');
  if (await isDirty(page)) throw new Error('the working copy is still dirty after a commit');
  const firstLog = await loggedCommitIds(page);
  note('commit', `${firstLog.length} commits reachable from the new head`);

  // --- export HTML ------------------------------------------------------------------------------

  const export1 = await exportToFile(page, 'html', target.dir, 'journey-1.html');
  const file1 = containerOf(await readBack(export1.path));
  if (!file1.model.components.some((c) => c.name === 'Payment API')) {
    throw new Error('the exported file does not contain the edit that was just committed');
  }
  note('export', `${export1.name} by ${export1.method}; head ${short(file1.head)}`);

  // --- reopen in a clean profile ----------------------------------------------------------------

  const second = await browser.newContext();
  const other = await second.newPage();
  await openArtifact(other, target.urlOf(export1.name));
  const reopened = containerOf(await readBack(export1.path));
  if (reopened.head !== file1.head) throw new Error('the reopened file is not at the exported head');
  const otherLog = await loggedCommitIds(other);
  if (otherLog.length !== firstLog.length) {
    throw new Error(`the clean profile has ${otherLog.length} commits, the export carried ${firstLog.length}`);
  }
  note('reopen', `a clean profile opened the export at ${short(file1.head)} with ${otherLog.length} commits`);

  await goSection(other, 'architecture', 'components');
  await addEntity(other, 'components', { Name: 'Ledger', Type: 'process' });
  await commit(other, 'Add the ledger component');
  const export2 = await exportToFile(other, 'html', target.dir, 'journey-2.html');
  const file2 = containerOf(await readBack(export2.path));
  if (file2.history.head === file1.head) throw new Error('the second export is at the first head');
  note('edit+export', `${export2.name} at ${short(file2.history.head)}, parented on ${short(file1.head)}`);

  // --- back in the first profile, with its own new work ------------------------------------------

  await goSection(page, 'architecture', 'components');
  await addEntity(page, 'components', { Name: 'Reporting', Type: 'process' });
  await commit(page, 'Add the reporting component');
  const localExport = await exportToFile(page, 'native', target.dir, 'local.tmv.json');
  const localHead = JSON.parse(await readBack(localExport.path)).history.head;
  note('local work', `the first profile is now at ${short(localHead)}`);

  // --- import into the first profile ------------------------------------------------------------

  await importFile(page, export2.path);
  const prompt = await importPrompt(page);
  const promptText = await prompt.innerText();
  if (!promptText.includes(file2.model.name)) {
    throw new Error('the import prompt does not name the model the document carries');
  }
  await prompt.locator('[data-action="cancel"]').click();
  await prompt.waitFor({ state: 'detached' });
  note('import', 'importing the second export raised the duplicate-model prompt and nothing was merged');

  // --- open it, which is the path that reconciles ------------------------------------------------

  await openArtifact(page, target.urlOf(export2.name));
  const compare = await compareView(page);
  const compareText = await compare.innerText();
  for (const wanted of ['Compare and merge', short(localHead), short(file2.history.head)]) {
    if (!compareText.includes(wanted)) {
      throw new Error(`the compare view does not name ${wanted}; it says: ${compareText.slice(0, 400)}`);
    }
  }
  note('reconcile', 'the diverged file reached the compare view, which names both heads');

  await acceptAndMerge(page, 'Merge the ledger and reporting work');
  const mergeLog = await loggedCommitIds(page);
  if (mergeLog.length <= Math.max(firstLog.length, otherLog.length)) {
    throw new Error('the merge did not add a commit');
  }
  note('merge', `${mergeLog.length} commits reachable from the merged head ${short(mergeLog[0])}`);

  // --- export again, and read the whole thing back -----------------------------------------------

  const export3 = await exportToFile(page, 'html', target.dir, 'journey-3.html');
  const text3 = await readBack(export3.path);
  const file3 = containerOf(text3);
  const mergeCommit = file3.commits.filter((c) => c.id === file3.head)[0];
  if (!mergeCommit || !mergeCommit.parents || mergeCommit.parents.length !== 2) {
    throw new Error('the exported head is not the merge commit');
  }
  const reachable = new Set();
  const walk = [file3.head];
  while (walk.length) {
    const id = walk.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    const found = file3.commits.filter((c) => c.id === id)[0];
    for (const parent of (found && found.parents) || []) walk.push(parent);
  }
  const lostSides = [localHead, file2.history.head].filter((id) => !reachable.has(id));
  if (lostSides.length) {
    throw new Error('the export lost a side of the merge: ' + lostSides.join(', '));
  }
  if (await isDirty(page)) throw new Error('the working copy is dirty after a merge');
  note('export', `${export3.name} carries ${file3.commits.length} commits and both merge parents`);

  await first.close();
  await second.close();
  report.headBefore = localHead;
  report.headAfter = file3.head;
  return report;
}

function short(id) {
  return String(id).replace(/^sha256:/, '').slice(0, 7);
}

async function readBack(file) {
  const fs = await import('node:fs');
  return fs.readFileSync(file, 'utf8');
}

/** Re-exported so a spec can read a container without importing the fixture module too. */
export { dataBlockOf };
