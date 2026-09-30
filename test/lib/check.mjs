/*
 * check.mjs — the one way a test in this suite declares itself.
 *
 * The traceability rule (`09-testing.md` §1) is bidirectional, and this file is what makes the second
 * direction mechanical. A test's name is not a label chosen after writing it: it is the name the
 * specification already cites. So `specTest` refuses a name that nothing cites, at the moment the
 * file is loaded, with the nearest cited names in the error — a typo is caught by running one file
 * rather than by the traceability test at the end, and the message says what to type instead.
 *
 * The collector in `traceability.test.mjs` parses these calls out of the sources, which is a second
 * implementation of the same fact. That redundancy is intentional: the runtime check cannot see a
 * test that was deleted from a file the collector no longer parses, and the collector cannot see
 * whether a name is spelled the way the spec spells it if the file never runs.
 *
 * **The traceability test's own cases are not declared here.** They are assertions about the
 * specification and the suite rather than tests any requirement asks for, so they have no cited name
 * to carry and are declared with `node:test` directly, under ordinary prose names. The exemption list
 * is for the release artifact, and `09-testing.md` §3 is explicit that it should stay one entry long;
 * quietly growing it to cover the checker itself would be the thing that rule exists to prevent.
 */

import test from 'node:test';

import { readSpec, EXEMPT, TEST_NAME } from './spec.mjs';

const { cited } = readSpec();

/**
 * Exempt names are declarable but not cited.
 *
 * `09-testing.md` §3 exempts a test that checks a condition of the release artifact rather than a
 * behaviour anyone asked for. The exemption is about *citation*, not about declaration: such a test
 * is still a test, still runs, and still has to be declared somewhere — so it is declared here, like
 * every other test, rather than in some second way that would exist only for the exempt ones.
 */
const exempt = new Set(EXEMPT);

/** Every cited name, for the "did you mean" list. */
export const CITED_NAMES = [...cited.keys()].sort();

function nearest(name) {
  const head = name.split('.')[0];
  return CITED_NAMES.filter((n) => n.startsWith(`${head}.`)).slice(0, 8).join(', ') || CITED_NAMES.slice(0, 8).join(', ');
}

/**
 * Refuse a name the specification does not account for.
 *
 * Both declaration forms below go through here, so there is one spelling of the rule and one error
 * message — `specTest` and `e2eTest` differ only in what they do with a name that passes.
 */
function checkName(name) {
  if (!TEST_NAME.test(name)) {
    throw new Error(
      `test name ${JSON.stringify(name)} is not a dotted identifier. Every test in this suite is ` +
        `named for a requirement's \`- **Test:**\` line, and those are \`domain.name\`.`,
    );
  }
  if (!cited.has(name) && !exempt.has(name)) {
    throw new Error(
      `no requirement or citing table names ${JSON.stringify(name)}. Traceability runs both ways ` +
        `(09-testing.md §1), so a test nothing asks for has to be either renamed to a cited name or ` +
        `added to EXEMPT in test/lib/spec.mjs. Cited names beginning "${name.split('.')[0]}.": ${nearest(name)}`,
    );
  }
}

/**
 * Declare a test whose name the specification cites.
 *
 * @param {string} name  a `- **Test:**` name, verbatim
 * @param {Function} fn  the body; for a parameterised test, take `(t)` and use `t.test(...)`
 */
export function specTest(name, fn) {
  checkName(name);
  test(name, fn);
}

/**
 * Declare a *browser* test — the same name check, for a suite `node --test` does not run.
 *
 * The end-to-end specs run under Playwright, which has its own runner and its own `test()`. Calling
 * `specTest` from one would register a Node test inside a Playwright worker, which is not what any of
 * the three is for. So this validates the name and hands it back, and the spec passes it to
 * Playwright's runner:
 *
 *     test(e2eTest('e2e.ui.shell'), async ({ page }) => { … });
 *
 * The point is that the name is still checked at load, and still discoverable by the collector in
 * `traceability.test.mjs` — an e2e test that is cited but missing, or present but misspelled, has to
 * fail somewhere, and neither the Playwright run nor the traceability test would notice on its own.
 */
export function e2eTest(name) {
  checkName(name);
  return name;
}
