/*
 * shell.mjs — driving the artifact the way a person does.
 *
 * Everything here is a real interaction: a click on an element the application rendered, or a
 * keystroke in a control it owns. Nothing reaches into the application's internals, and that is a
 * deliberate constraint rather than a stylistic one. The claims these specs exist to check — that a
 * classic inline script boots under `file://`, that the CSP hash still matches after concatenation,
 * that a diverged file reaches the compare view — are claims about the *page*, and a test that
 * poked `TMV.shell` directly would still pass if the page never rendered a single control.
 *
 * The one exception is reading the embedded data block out of an exported file, and that is not an
 * exception at all: the data block is the product.
 *
 * Selectors are used rather than text wherever the markup offers an id or a `data-action`, because
 * the labels are prose and prose is edited. Where a text selector is unavoidable it is scoped to the
 * region that owns it.
 */

import path from 'node:path';

/** The opening tag of the embedded container data block. Split so this file cannot be mistaken for markup. */
const DATA_OPEN = '<' + 'script type="application/json" id="tmv-data">';
const DATA_CLOSE = '</' + 'script>';

// ---------------------------------------------------------------------------------------------
// Reading the artifact
// ---------------------------------------------------------------------------------------------

/**
 * The container an exported file carries, parsed.
 *
 * `indexOf` rather than a regular expression because the block is around a megabyte in an application
 * export and a non-greedy `.*?` over that is the slowest thing in the suite for no gain. The closing
 * tag search starts after the opening one, so an unrelated `</script>` in the page's own script text
 * cannot end the scan early — there is one data block and this finds it.
 */
export function dataBlockOf(text) {
  const start = text.indexOf(DATA_OPEN);
  if (start === -1) throw new Error('the file carries no ' + DATA_OPEN + ' block');
  const from = start + DATA_OPEN.length;
  const end = text.indexOf(DATA_CLOSE, from);
  if (end === -1) throw new Error('the data block is not closed');
  return JSON.parse(text.slice(from, end));
}

/** The model and the history an exported file would be read for. */
export function containerOf(text) {
  const block = dataBlockOf(text);
  return {
    model: block.model,
    history: block.history,
    build: block.build,
    head: block.history && block.history.head,
    commits: (block.history && block.history.commits) || [],
  };
}

/** A commit's message, by id. */
export function commitMessage(text, id) {
  const found = containerOf(text).commits.filter((c) => c.id === id)[0];
  if (!found) throw new Error('no commit ' + id + ' in the file');
  return found.message;
}

export function commitIds(text) {
  return containerOf(text).commits.map((c) => c.id);
}

// ---------------------------------------------------------------------------------------------
// Booting
// ---------------------------------------------------------------------------------------------

/**
 * Open a file and wait until the shell is up.
 *
 * The wait is on the *rendered* result rather than on the load event: boot is synchronous, so by the
 * time `load` fires the application has either mounted a tab or stopped on one of §6's failure
 * screens. Waiting for the content region to hold one of those two and then reporting the failure
 * screen's own words is what turns "the test timed out" into "the file did not open, and here is
 * what it said".
 */
export async function openArtifact(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await settle(page);
}

export async function settle(page) {
  await page.waitForSelector('#tmv-content h1.tmv-view__title, #tmv-content .tmv-screen', { timeout: 60000 });
  const failure = page.locator('#tmv-content .tmv-screen');
  if (await failure.count()) {
    throw new Error('the application stopped on a failure screen: ' + (await failure.first().innerText()));
  }
  // The side nav is built from the tab list, so a row is proof the shell mounted rather than a
  // half-rendered content region.
  await page.waitForSelector('#tmv-side-nav-items [data-action="side-nav"]', { timeout: 15000 });
  return page;
}

/** The model name the switcher is showing — the cheapest evidence that a model is open. */
export async function openModelName(page) {
  return (await page.locator('#tmv-model-trigger .tmv-switcher__name').innerText()).trim();
}

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

export async function goTab(page, tabId) {
  await page.locator(`#tmv-tabs [role="tab"][data-value="${tabId}"]`).click();
  await page.waitForFunction(
    (id) => {
      const node = document.querySelector(`#tmv-tabs [role="tab"][data-value="${id}"]`);
      return !!node && node.getAttribute('aria-selected') === 'true';
    },
    tabId,
  );
  return page;
}

export async function goSection(page, tabId, sectionId) {
  await goTab(page, tabId);
  if (!sectionId) return page;
  await page.locator(`#tmv-side-nav-items [data-action="side-nav"][data-value="${sectionId}"]`).click();
  return page;
}

/** The heading the content region is currently showing — the *tab's* label, which is what it renders. */
export async function heading(page) {
  return (await page.locator('#tmv-content h1.tmv-view__title').innerText()).trim();
}

/**
 * The title of the section the side nav has open.
 *
 * Not the same thing as `heading`, and the difference matters: the `h1` in the content region is the
 * tab's own label (`17-shell.js` writes it once per tab), while each section underneath draws its own
 * `h2`. Asserting a section by the `h1` would be asserting the tab, which passes whatever section is
 * open — a check that cannot fail is worse than no check.
 */
export async function sectionTitle(page) {
  return (await page.locator('#tmv-content .tmv-section__title').first().innerText()).trim();
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

/**
 * Create one entity through the list's own "Add" button and the entity form.
 *
 * `collection` is the collection key the application uses for the section — the same value the side
 * nav carries as `data-value` and the form as `data-type` (`components`, `threats`, `controls`, …).
 * It is the plural, because that is the key everywhere the two have to agree; the singular is only on
 * the add button's own `data-name`.
 *
 * `values` is keyed by the form's own labels. That means a spec names the fields a person sees rather
 * than the model's property names, which is the difference between a test that breaks when the model
 * changes and one that breaks when the form does — and the form is what this test is about.
 *
 * Every control here is a text input or a textarea. The two pickers on a component form (`Parent`,
 * `Trust zone`) are comboboxes with their own widgets, and nothing in this suite needs them: the fields
 * that decide which entity was created are the name and the type.
 */
export async function addEntity(page, collection, values) {
  await page.locator('#tmv-content [data-action="add-entity"]').first().click();
  const form = page.locator(`#tmv-layers form[data-type="${collection}"]`);
  await form.waitFor({ state: 'visible' });

  const labels = Object.keys(values);
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    await form.getByLabel(label, { exact: true }).fill(String(values[label]));
  }

  await page.locator('#tmv-layers [data-action="form-save"]').click();
  await form.waitFor({ state: 'detached' });
  return page;
}

/**
 * Count the rows a list section is showing.
 *
 * `tr[data-row]` rather than `tbody tr`: a list with nothing in it still renders a `<tbody>` with one
 * row in it — the table's own empty notice — so counting every row makes an empty list and a one-item
 * list the same number, and an assertion that "adding an entity added a row" passes for a list that
 * never changed. The application marks a real row with the id of the entity it holds, which is exactly
 * the distinction this needs.
 */
export async function rowCount(page) {
  return page.locator('#tmv-content tbody tr[data-row]').count();
}

/** Whether the header is saying the working copy has uncommitted changes. */
export async function isDirty(page) {
  return page.locator('#tmv-dirty').isVisible();
}

/** Commit the working copy, through the header's own commit button and dialog. */
export async function commit(page, message) {
  await page.locator('#tmv-commit').click();
  const area = page.locator('#tmv-layers textarea[data-action="commit-message"]');
  await area.waitFor({ state: 'visible' });
  await area.fill(message);
  await page.locator('#tmv-layers [data-action="commit"]').click();
  await area.waitFor({ state: 'detached' });
  return page;
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

async function chooseExportFormat(page, format) {
  await page
    .locator(`#tmv-content [role="tablist"][aria-label="Export format"] [data-action="switch"][data-value="${format}"]`)
    .click();
  await page
    .locator(`#tmv-content [data-action="export-download"][data-value="${format}"]`)
    .waitFor({ state: 'visible' });
}

/**
 * Export, and get the bytes — by download if the browser starts one, from the on-screen fallback if
 * it does not.
 *
 * REQ-EXP-012 requires both paths and is explicit that the fallback is not a failure: under `file://`
 * some engines refuse to start a download from a blob URL, and the answer is to show the whole file
 * so it can be saved by hand. A helper that only understood downloads would turn the documented
 * degradation into a test failure, which is the opposite of what the requirement asks for.
 *
 * The two outcomes are raced rather than tried in order. Waiting on the download event alone costs its
 * full timeout on every export in the fallback case, and the core journey exports three times per
 * protocol — long enough to turn a slow path into a failure that reads as a hang.
 */
export async function exportToFile(page, format, dir, fallbackName) {
  await goSection(page, 'settings', 'export');
  await chooseExportFormat(page, format);

  const button = page.locator(`#tmv-content [data-action="export-download"][data-value="${format}"]`);
  const fallback = page.locator('#tmv-content .cds--snippet__pre code').first();
  const downloaded = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  const shown = fallback
    .waitFor({ state: 'attached', timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  await button.click();
  const first = await Promise.race([downloaded, shown]);

  if (first && typeof first !== 'boolean') {
    const name = first.suggestedFilename();
    const target = path.join(dir, name);
    await first.saveAs(target);
    return { method: 'download', name, path: target };
  }

  // The fallback block is rendered only after the download route has been refused, so neither outcome
  // arriving means the export neither downloaded nor offered its text — which is the failure. The
  // content is read from the snippet, which holds the whole file as text.
  if (first !== true && !(await shown)) {
    throw new Error(`the ${format} export neither downloaded nor showed its text`);
  }
  const name = fallbackName || 'export.html';
  const target = path.join(dir, name);
  const fs = await import('node:fs');
  fs.writeFileSync(target, await fallback.textContent(), 'utf8');
  return { method: 'fallback', name, path: target };
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

/** Hand a file to the Import screen's drop zone, through the input it is bound to. */
export async function importFile(page, filePath) {
  await goSection(page, 'settings', 'import');
  await page.locator('#tmv-import-file').setInputFiles(filePath);
  return page;
}

/** The modal the shell raises when an import names a model this browser already has. */
export async function importPrompt(page) {
  const modal = page.locator('#tmv-layers .cds--modal').filter({ hasText: 'already open in this browser' });
  await modal.waitFor({ state: 'visible', timeout: 15000 });
  return modal;
}

// ---------------------------------------------------------------------------------------------
// History, compare and merge
// ---------------------------------------------------------------------------------------------

/** The commit ids the History log is listing, in the order it lists them. */
export async function loggedCommitIds(page) {
  await goSection(page, 'history', 'log');
  return page.locator('#tmv-content tbody tr[data-row]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-row')),
  );
}

/** Open the compare view and hand back its host, which exists only when a comparison is open. */
export async function compareView(page) {
  await goSection(page, 'history', 'compare');
  const host = page.locator('#tmv-content .tmv-compare-host');
  await host.waitFor({ state: 'attached' });
  return host;
}

/**
 * Accept every suggestion and merge.
 *
 * The two sides in the core journey add different entities, so the suggestions are the union and no
 * decision is left for the user — which is what makes this deterministic. The ack checkbox appears
 * only when the merged model has problems, and it is ticked if it is there rather than assumed
 * absent, because a resolution that produces a problem is a real outcome this path can reach.
 */
export async function acceptAndMerge(page, message) {
  await page.locator('#tmv-content [data-action="accept-suggestions"]').click();

  // The confirm button is disabled until every decision has an answer, so clicking it is also the
  // assertion that the suggestions were enough — a plan with a conflict left over would never reach
  // the dialog, and the wait would time out naming the button rather than the decision.
  const confirm = page.locator('#tmv-content [data-action="confirm"]');
  await confirm.click();

  const dialog = page.locator('#tmv-layers .cds--modal').filter({ hasText: 'Confirm merge' });
  await dialog.waitFor({ state: 'visible' });
  const area = dialog.locator('textarea[data-action="merge-message"]');
  // The dialog pre-fills a generated message. A caller that names one means it, so it replaces the
  // default rather than being dropped when the default happens to be non-empty — a merge message is
  // part of the commit id and therefore part of what the test is identifying.
  if (message) await area.fill(message);

  const ack = dialog.locator('input[type="checkbox"]');
  if (await ack.count()) {
    for (let i = 0; i < (await ack.count()); i += 1) await ack.nth(i).check({ force: true });
  }

  const merge = dialog.locator('[data-action="merge"]');
  await merge.waitFor({ state: 'visible' });
  await merge.click();
  await dialog.waitFor({ state: 'detached' });
  return page;
}
