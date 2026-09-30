/*
 * shell.spec.mjs — REQ-UI-001 and REQ-UI-006, against the built artifact in a real browser.
 *
 * Both requirements are about *layout*, which is the one class of claim the unit harness cannot
 * check at all: `test/lib/dom.mjs` is a stub with no stylesheet, no box model and no viewport, so it
 * can see that a class was set and never that the thing it styles ended up in the right place. The
 * Carbon UI shell is also the largest hand-written workstream in the project (ADR-0002 — Carbon v11
 * ships no JavaScript), so "the header, the tabs, the side nav and the content are there and lined up"
 * is a claim that has to be made where the CSS actually resolves.
 *
 * Two things are asserted rather than one, and the second is the one that would have caught the
 * mistakes this project actually made. AC1 is the obvious one: the `cds--` classes are present. But
 * the classes were present in the version of this file whose tab strip was built from a second copy
 * of the tab list, whose tabs had neither `data-value` nor `data-action`, and whose side nav offset
 * was applied per region and disagreed with itself. So the specs also assert the *geometry* — the
 * header is pinned and 48px, the nav is beside the content rather than under it, the content starts
 * below the header — because that is what the classes are for.
 */

import { test, expect } from '@playwright/test';

import { e2eTest } from '../test/lib/check.mjs';
import { artifactText } from './fixtures.mjs';
import { fileTarget } from './fixtures.mjs';
import { openArtifact } from './shell.mjs';

/** The Carbon header height, in CSS pixels. `--tmv-header-h` is 3rem and the root is 16px. */
const HEADER_HEIGHT = 48;

test.describe('the Carbon UI shell', () => {
  test(e2eTest('e2e.ui.shell'), async ({ browser }) => {
    const target = fileTarget(artifactText());
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await openArtifact(page, target.url);

    // --- AC1: the four regions, each carrying the pinned stylesheet's own classes -----------------

    const regions = [
      ['header', '#tmv-header', 'cds--header'],
      ['tabs', '#tmv-tabs', 'cds--tabs'],
      ['side nav', '#tmv-side-nav', 'cds--side-nav'],
      ['content', '#tmv-content', 'cds--content'],
    ];
    for (const [name, selector, wanted] of regions) {
      const node = page.locator(selector);
      await expect(node, `${name} is missing from the shell`).toHaveCount(1);
      const classes = await node.getAttribute('class');
      expect(classes.split(/\s+/), `${name} does not carry ${wanted}`).toContain(wanted);
    }

    // The side nav is populated from the tab declaration, and the tab strip from the same source.
    // A count of zero here would mean the shell mounted with nothing to navigate to.
    expect(await page.locator('#tmv-tabs [role="tab"]').count()).toBeGreaterThanOrEqual(9);
    expect(await page.locator('#tmv-side-nav-items [data-action="side-nav"]').count()).toBeGreaterThanOrEqual(5);

    // --- AC2: the pinned stylesheet is the one doing the work ------------------------------------
    //
    // If the Carbon stylesheet is refused — a bad integrity digest, an unreachable CDN, a substituted
    // file — the classes above are still present and the layout is whatever `00-app.css` alone
    // produces. So the stylesheet is checked for having *arrived*, by a rule only Carbon can supply:
    // `.cds--header` is a flex row 3rem tall. Nothing in `00-app.css` sets that height.

    const header = await page.locator('#tmv-header').boundingBox();
    expect(Math.round(header.height), 'the header is not Carbon’s 3rem').toBe(HEADER_HEIGHT);

    const stylesheets = await page.evaluate(() =>
      Array.from(document.styleSheets).map((sheet) => sheet.href || 'inline'),
    );
    expect(
      stylesheets.some((href) => String(href).includes('@carbon/styles')),
      'the pinned Carbon stylesheet is not among the document’s stylesheets: ' + stylesheets.join(', '),
    ).toBe(true);

    // --- geometry: the shell is where §1 draws it ------------------------------------------------

    const nav = await page.locator('#tmv-side-nav').boundingBox();
    const content = await page.locator('#tmv-content').boundingBox();
    const tabs = await page.locator('#tmv-tabs').boundingBox();

    // The nav is a column to the left of the content, not above or beneath it.
    expect(nav.x + nav.width, 'the side nav overlaps the content region').toBeLessThanOrEqual(content.x + 1);
    // The tab strip is in the shell's flow, above the content, and clears the fixed header.
    expect(tabs.y, 'the tab strip is hidden behind the header').toBeGreaterThanOrEqual(HEADER_HEIGHT - 1);
    expect(tabs.y + tabs.height, 'the content overlaps the tab strip').toBeLessThanOrEqual(content.y + 1);

    // The header is fixed: it stays at the top of the viewport once the page scrolls.
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(50);
    const scrolled = await page.locator('#tmv-header').boundingBox();
    expect(Math.round(scrolled.y), 'the header scrolled away instead of staying pinned').toBe(0);
    await page.evaluate(() => window.scrollTo(0, 0));

    await context.close();
  });

  test(e2eTest('e2e.ui.responsive'), async ({ browser }) => {
    const target = fileTarget(artifactText());
    // 320px is the width REQ-UI-006 names, and it is the narrowest viewport any current phone
    // reports in its default orientation.
    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
    const page = await context.newPage();
    await openArtifact(page, target.url);

    // --- AC1: the side nav is not a column at this width -----------------------------------------
    //
    // §7: below `sm` the nav is a drawer over the content rather than a track beside it, so the shell
    // must not be displaced by it. This is the assertion that fails if the drawer's own
    // `--expanded` rule wins on specificity and pushes the whole page 16rem sideways.

    const nav = await page.locator('#tmv-side-nav').boundingBox();
    const content = await page.locator('#tmv-content').boundingBox();
    expect(
      content.x,
      'the content is indented by the side nav at 320px, so the nav is a column and not a drawer',
    ).toBeLessThanOrEqual(1);
    expect(nav.width, 'the side nav is off-canvas at 320px without a way back').toBeLessThanOrEqual(320);

    // The drawer's trigger exists and is displayed — §7's one control at `sm`. Without it, an
    // off-canvas nav would be a nav no one could open.
    const trigger = page.locator('#tmv-sidenav-trigger');
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const opened = await page.locator('#tmv-side-nav').boundingBox();
    expect(opened.width, 'the drawer did not open over the content').toBeGreaterThan(100);
    expect(
      (await page.locator('#tmv-content').boundingBox()).x,
      'opening the drawer displaced the content instead of covering it',
    ).toBeLessThanOrEqual(1);

    // --- AC1, second half: the tab row scrolls rather than wrapping ------------------------------

    const scrolling = await page.evaluate(() => {
      const list = document.querySelector('.tmv-tabs .cds--tab--list');
      if (!list) return null;
      const style = getComputedStyle(list);
      return { overflowX: style.overflowX, scrollWidth: list.scrollWidth, clientWidth: list.clientWidth };
    });
    expect(scrolling, 'the tab strip has no list element').not.toBeNull();
    expect(scrolling.overflowX, 'the tab row does not scroll').toBe('auto');
    expect(
      scrolling.scrollWidth,
      'the nine tabs fit at 320px, so this viewport does not exercise the scroll',
    ).toBeGreaterThan(scrolling.clientWidth);

    // --- AC2: no horizontal overflow at 320px ----------------------------------------------------

    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    // The tab strip is allowed to be wider than the viewport — it scrolls inside its own container,
    // and `09-testing.md` §7 says so. What must not happen is the *page* scrolling sideways.
    expect(overflow.viewport, 'the viewport is not 320px, so this assertion means nothing').toBe(320);
    expect(overflow.document, 'the page scrolls horizontally at 320px').toBeLessThanOrEqual(320);
    expect(overflow.body, 'the body overflows the viewport at 320px').toBeLessThanOrEqual(320);

    // --- AC2, third: a control that hides its own options ------------------------------------------
    //
    // The one way this page can "fit" at 320px and still be unusable is by clipping. Carbon's content
    // switcher does exactly that: one row, equal shares, `overflow: hidden` on the button and
    // `text-overflow: ellipsis` on the label, so an option that does not fit loses its tail instead of
    // pushing anything. At 320px the four theme names did not fit, and the Appearance screen drew
    // "Gray 10" and "Gray 90" as the same visible "Gray …" — a switcher that offered three dark themes
    // and displayed two. Nothing in the overflow assertions above can see that, which is why this one
    // measures the label against itself rather than the page against the viewport.

    await page.locator('#tmv-sidenav-trigger').click(); // close the drawer the AC1 block opened
    await page.locator('#tmv-tabs [role="tab"][data-value="settings"]').dispatchEvent('click');
    await page.waitForTimeout(200);
    const appearance = page.locator('#tmv-side-nav-items [data-action="side-nav"][data-value="appearance"]');
    expect(await appearance.count(), 'Appearance is not in the side nav, so this check is vacuous').toBe(1);
    await appearance.dispatchEvent('click');
    await page.waitForTimeout(200);

    const switchers = await page.evaluate(() =>
      [...document.querySelectorAll('.cds--content-switcher')].map((sw) => ({
        label: sw.getAttribute('aria-label'),
        options: [...sw.querySelectorAll('.cds--content-switcher__label')].map((el) => ({
          text: el.textContent.trim(),
          clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
        })),
      })),
    );
    expect(switchers.length, 'no content switcher rendered, so this check is vacuous').toBeGreaterThanOrEqual(2);

    const clipped = switchers.flatMap((sw) => sw.options.filter((o) => o.clipped).map((o) => o.text));
    expect(clipped, 'a content-switcher option is cut off at 320px').toEqual([]);

    // The four themes are the ones that did not fit; the name is asserted as well as the fit, because a
    // switcher that rendered only two of its four options would also report nothing clipped.
    const theme = switchers.find((sw) => sw.options.length === 4);
    expect(theme, 'the theme switcher is not on the Appearance screen').toBeTruthy();
    expect(theme.options.map((o) => o.text)).toEqual(['White', 'Gray 10', 'Gray 90', 'Gray 100']);

    await context.close();
  });
});
