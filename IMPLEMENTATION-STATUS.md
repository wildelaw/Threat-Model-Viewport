# Implementation status

Where the implementation and the specification differ, and why.

The specification is authoritative (`CLAUDE.md`). This document does not change it. It records the
places where the code had to *interpret* a requirement, *depart* from it, or *resolve* something the
spec deliberately left open — because each of those is a decision that a reader of the code would
otherwise have to reconstruct from a comment, and several of them are the kind of thing that looks
like a bug until you know the reason.

Every entry names the code it applies to, so a reader can check it, and says which of the three it is:

- **Deviation** — the code does something other than what the spec's text says.
- **Interpretation** — the spec is silent; this is the smallest thing consistent with the ADRs.
- **Correction** — the spec's text is wrong on a narrow point, and following it literally would break
  a requirement elsewhere.

An entry here is not a licence to drift. A deviation that a *requirement* depends on would be an ADR
(`CLAUDE.md`, *Editing the spec*). Nothing below is that: they are all places where the spec's prose
and its requirements pull apart slightly, and the requirement won.

---

## Data model

### Geometry is nested, not flat (`05-model.js`, `representationElement`)

`03-data-model.md` §4.15 prints an element's geometry as flat `x`, `y`, `width`, `height`. The model
stores `position: {x, y}` and `size: {width, height}`.

**Deviation.** The reason is a collision the spec does not acknowledge: `03-data-model.md` §4 puts the
passthrough bag at the property `x` on *every* entity without exception, and §10 promises an OTM round
trip is lossless. A numeric `x` here would make the two mutually exclusive — an element carrying
`attributes`, or any key this model does not recognise, would lose either its coordinate or that key.
Nesting also matches OTM's own wire shape, so unknown keys *inside* `position` and `size` survive the
mapping verbatim with no extra machinery.

### Vocabularies are TML's spellings, verbatim (`05-model.js`, `VOCAB`)

`03-data-model.md` §3.1 writes the trust-zone tiers in camelCase (`missionCritical`). The model stores
`mission_critical`, and `09-tml.js` maps `scope` 1:1 by vocabulary rather than through a translation
table.

**Deviation.** The vendored TML 1.0.2 schema declares the snake_case spellings, so storing anything
else would mean import translates one way and export translates back — a table that is right for a
year and then silently drops a value. Storing TML's own spelling makes the mapping a copy in both
directions.

### The `<!--` escape is written `<!--` (`04-container.js`)

`02-architecture.md` §4's table writes the case as ``<\!--``.

**Correction.** That literal is not valid JSON — `\!` is not in the JSON grammar — so a data block
containing `<!--` would not parse at all, which is precisely the round trip `REQ-DATA-002` requires.
What is implemented is the table's intent: escape the sequence so a comment-parser cannot swallow the
block, using a form that parses.

---

## Interchange

### TML export drops mitigation plans (`09-tml.js`)

`06-interchange.md` §7's lossiness ledger lists the mitigation-plan entity and §6.1 maps it on import,
but the vendored TML 1.0.2 root schema has `additionalProperties: false` and declares no
`mitigation_plans` property. §6.2's export table has no row for it.

**Deviation.** Writing the key anyway was tried and is not survivable: `interchange` validates its own
output (`REQ-EXP-001`, `REQ-EXP-002`) and a failed self-check blocks the download (`REQ-EXP-010`), so a
model with one mitigation plan could not be exported to TML at all — for a reason that reads to the
user as a bug in the application, which it was.

Import still reads the key when a document from another tool carries it, so nothing is destroyed on
the way in. What changes is the way out: the plans are dropped and disclosed under `REQ-EXP-003` like
every other thing TML cannot hold. That is a worse outcome for the data than a non-conforming key, and
a better one than an export that refuses to run.

### Flow endpoints resolve their type through the *input* vocabulary (`09-tml.js`)
Not a spec deviation, but the one defect worth recording, because every test that existed was blind to
it and the code that replaced it looks redundant unless you know why.

**Correction.** The *output* spelling was used as the key into the *canonical* collection table. For
the two spellings that happen to agree (`component`, `data-store`) it worked by accident, so the
defect hid until a flow ended at a target whose spelling differed — at which point the lookup missed
and **every such flow was reported dangling**, blocking an export for a model that was perfectly
complete (`REQ-IMP-007`). It surfaced the first time a model with a store-ended flow was exported back
to TML, which the import-side round-trip tests had never done. Everything now goes through
`ENDPOINT_IN` first, so `data-store`, `data_store` and `#/$defs/data-store` all resolve the same way.

### OTM import drops a reference that names nothing (`08-otm.js`)

Neither OTM nor TML enforces referential integrity, so a document can arrive with a `dataflows[].source`
naming an absent component and validate perfectly against its own schema.

**Interpretation.** Importing it faithfully would put a broken model in the editor; dropping the
reference loses only a fact that was never there. The second is the honest choice and it is reported
(`REQ-IMP-004`), so "3 references unresolved" means something the user can act on. The pass runs to a
fixed point, because removing a link can empty a container other references pointed into.

Which references dangle is decided by `model.validate`, never by a second resolution rule written in
the OTM module. A typed reference — a flow endpoint whose `sourceType` contradicts its `sourceId` — is
only correct if both places agree, and two implementations of that judgement is how they come to
disagree.

### `components_affected` resolves across every collection, in both directions (`09-tml.js`)

`06-interchange.md` §4.10 types every entry of a threat's `components_affected` as a component.

**Interpretation.** TML's schema types the field as a bare `symbolic-name`, and the vendored wallet
example lists a data store in it. §4.10's word is the right *default* and the wrong *rule*: taking it
literally on the import side made the two halves of the mapping disagree about the same document. A
threat applied to a data flow was written out by name and read back as a reference to a component that
does not exist, so the application's own export failed its own re-import — `REQ-IMP-007`'s promise,
broken on the way out rather than the way in, which is why the round-trip tests that only ever went
inward never saw it. Both halves now resolve the name across every collection, and the import records
`targetType: 'dataFlow'` when that is what the name turned out to be. A data flow is the one
alternative the canonical `targetType` vocabulary can hold; anything else keeps the spec's `component`
default, and where that does not resolve `REQ-IMP-004` reports it.

### A dangling reference blocks the export only where the format copies it verbatim

`08-otm.js`, `09-tml.js`, together with `05-model.js`'s `validate`.

**Interpretation.** Neither format enforces referential integrity, so a model can hold a reference that
names nothing. Which of the two ways of dealing with it is honest depends on what the export does with
the reference. Blocking is right where the export writes *the reference itself* into the document and
the recipient's tool would then hold a name it cannot resolve — a flow's endpoints, a trust zone's
`parentId`, a representation element's `representationId` (OTM) — because there is no version of that
document that is not broken. Everywhere else the reference is *dropped and disclosed* under
`REQ-EXP-003`: one entry per reference, naming the field that held it and the id it named, so the export
dialogue can say what will not survive. Refusing the whole export would withhold a usable file over a
fault the model already reports in its own right.

The set of fields on each side of that line is not a hand-written list, which is what keeps it from
rotting: `interop.referential-integrity` dangles every reference field the model declares and fails on
any that is neither blocked nor reported, so the sweep in `reportDroppedRefs` cannot drift from the
writers it describes — nor a new reference field be added to the model without a decision about which
side of the line it falls on.

---

## Export

### The document is serialized by hand (`11-export.js`)

`02-architecture.md` §7 writes `clone.outerHTML`.

**Correction.** `outerHTML` is on the forbidden list in `09-testing.md` §5 — the same list that keeps
rendered model data from reaching the DOM — and using it for our own markup would put back the one API
that can turn data into markup. The serializer emits elements and attributes directly, and it has a
second virtue: because the script element's text is written by us, `REQ-EXP-009`'s byte-identity is
something this file can *assert* rather than hope for.

---

## Editing

### The form is stricter than the model in two places (`15-forms.js`, `inputProblems`)

- `name` is refused when absent. The model reports it as a *warning*, because an imported entity
  without a name is not invalid, it is unnamed.
- A non-integer in an `int` field is refused. `coerceField` would round it.

**Interpretation.** Both are cases where the control is stricter than the value it edits. The form is
the one place a user is being asked for a name, so accepting a blank one and warning about it
afterwards would be asking a question and ignoring the answer. And rounding a typed `1.5` up to `2` is
an edit the user did not make and cannot see.

### Bulk actions are on by default for entity lists (`18-views-shared.js`)

`REQ-EDIT-008` asks for multi-select with bulk delete and bulk field update. `listView` had the whole
machinery and `bulkEnabled()` was permanently false, because no call site ever passed `bulk` — so the
requirement was unmet and every unit test of the underlying function still passed.

**Correction.** It is a property of *entity* lists, so it is now the default for any list that names a
type rather than something each of twenty-six call sites has to remember. Forgetting it is invisible:
the table simply renders without a checkbox column and nothing anywhere says why. A list whose rows are
not entities opts out by not naming a type — the Unresolved References finding is a list of dangling
*references*, not of things, so there is nothing to bulk-edit or delete.

### The per-entity bulk outcome is a notification, not a dialog region (`15-forms.js`, `18-views-shared.js`)

`REQ-EDIT-008` AC1 asks that per-entity validation failures be reported without aborting the operation.

**Correction.** The bulk dialog closed the moment the patch was applied, so the report region it
carried was built and torn down in the same turn and its `setReport` had no caller — while the message
the user did see claimed each failure was listed with its own reason. The reasons now go where
`REQ-UI-009` puts outcomes: the notification detail, one line per refused entity, naming the field and
the reason. Both halves of the message are conditional, because "the rest were applied" is a lie when
nothing was — which is what happens when the field chosen has a rule the whole selection breaks.

### The model's own fields have a dialog of their own (`15-forms.js`, `modelDetailsDialog`)

`REQ-EDIT-001` scopes the working-copy edit flow to "every entity type", so until `REQ-EDIT-011` there
was no form for the model itself. `model.name` could be changed only by editing the embedded JSON or by
exporting, renaming and re-importing — and the second is not a rename at all, because the re-import
collides on `modelId`.

**Interpretation**, in the one place the new dialog had a choice to make. It writes only the fields the
user changed, measured against the values the dialog opened with. `description` is a free-form field,
so an import can leave something that is not a string in it — `description: {…}` is not reachable from
a textarea, and rebuilding the model from the controls would replace it with `''` without anyone having
touched it. That is precisely the failure `REQ-EDIT-009` exists to prevent at the entity level, and the
same reasoning applies one level up. The name is the exception that is *not* one: it is required, so a
blank one is refused at the field before the dialog can be accepted, and the check is `M.validate` on
the candidate model rather than a second implementation of the rule.

### A stored entry's name follows storage's head, not the file (`07-storage.js`, `seedRegistry`)

`05-storage.md` §3 had every presentation field of a registry entry re-derived from the file on each
load, the name included. That is what the code did, and it is right for the head, the count and the
size. It is wrong for the name, and the difference only shows once something can change it: commit a
rename to a file-backed model and the entry is named correctly until the next reload, at which point the
file's older name comes back even though storage's head carries the new one. The feature would look
broken on first use, and the bug would sit in the seed rather than in the rename.

**Correction** — `05-storage.md` §3 has been amended, and the sentence that said the file wins is now
explicit about its one exception. Where a `meta` record exists the entry's name comes from storage's own
registry entry, which `saveModel` already upserts from the committed model; only the source hint and the
last-opened time are refreshed from the file. `readMeta` has no name field and gaining one would be a
storage-layout change, which is why the registry entry is the record that wins rather than `meta`.

The residual is accepted and written down rather than papered over: `saveModel` writes `meta` before it
upserts the registry, so a write that fails between the two leaves the entry's name one commit behind
until the next successful save. §3 says so.

### The switcher shows the working copy's name for the current entry, and the file's name for the file

`07-ui.md` §4's first draft of this rule said the current entry shows the name in the working copy,
without qualification, so that an uncommitted rename is visible in the header before it is committed —
the same thing the dirty indicator says about the copy as a whole. The implementation scopes it to the
current entry when that entry is a *registry* entry, and leaves the file's entry alone.

**Correction** — §4 has been amended to match, because the implementation is the one that is right. The
embedded model's entry denotes the model *in this file*, and a rename is committed to a history and
never rewrites the file, so after renaming while the file's copy is open the two entries disagree. That
is the accurate answer rather than a stale one, and it is also what `e2e/file-protocol.spec.mjs` asserts
the header says when the file's model is the one open. The rule is bounded twice more: the delete
confirmation takes the committed name regardless, because it names what storage holds rather than what
is on screen, and the spoken name of the current entry follows its written name, since a control whose
two names disagree is its own defect.

---

## Shell and UI

The shell's own deviations are collected here because `17-shell.js` is where the spec's file list and
the hand-written Carbon kit meet.

### File numbering (`02-architecture.md` §3)

**Correction** — the spec's file list has been amended to the numbering the build uses. `12-widgets.js`
is the component kit, `17-shell.js` comes *before* the views so they can register into it at load
time, and `19-boot.js` is last. The alternative — renumbering the implementation to match the earlier
list — would have moved the shell after the views that depend on it.

### The shell owns the tab strip and the side nav

**Interpretation.** There is no tabs widget and no side-nav widget in `12-widgets.js`
(`role="tablist"` appears only in `contentSwitcher`), so both are hand-written in `17-shell.js`. The
tab strip is a Carbon-shaped `div.cds--tabs` containing `button[role=tab]` with both the
`cds--tab__nav-item` and `cds--tab__nav-link` classes on one element and no `li` wrapper, so the
tablist directly contains its tabs.

### One panel, not nine

**Deviation** from `07-ui.md` §1, which describes a panel per tab. The buttons are built once and only
their attributes change, because the roving tabindex lives on them and a rebuild would drop the focus
an arrow key just moved. `aria-controls` is on every tab and `aria-labelledby` is rewritten on the
panel at every switch.

### The model switcher is a listbox of `option`s, not a menu

**Interpretation.** `widgets.popup`'s `highlight()` writes `aria-selected` unconditionally, which is
valid on `option` and not on `menuitemradio`. Building the switcher as a dropdown — which `07-ui.md`
§5's inventory already provides — avoids adding an accessibility risk for no gain.

### Delete lives in the header overflow menu, and acts on the open model

**Interpretation.** A delete button nested inside a listbox option is neither valid ARIA nor reachable
by keyboard. `07-ui.md` §4's rules are still met: the entry is *absent*, not present-and-disabled,
when the open model is the file's own history, and the menu says why in words. `shell.deleteStored`
is exposed so Settings → Storage can delete any stored model, which is where `REQ-STORE-005`'s
"delete a model you do not have open" belongs.

### The Storage screen opens a model as well as deleting one (`18-views-settings.js`)

**Interpretation.** `07-ui.md` §4 puts the model switcher in the header and says nothing about
Settings → Storage beyond the section's name, and the first version of that table offered a Delete
button per row and no way to reach the model the row named. That is the one screen that shows stored
models by name, size and commit count, so it is where a user who is looking for work they saved goes
— and it answered with a control that only removed things.

The row's Open button calls `shell.switchModel`, which is the header switcher's own path, so the
dirty-working-copy guard and the announcement are shared rather than reimplemented. Two details:

- **The open row's Open button is disabled, not absent** — the opposite of the header's delete
  (`REQ-UI-004` AC2). Delete is *meaningless* for a model that is only in the file, so a dead control
  would mislead; open is meaningful for every row and merely already done for one, so a gap in the
  column would read as a missing control rather than a satisfied one. The row also carries an `open`
  tag, because a `title` on a disabled button is reachable by neither keyboard nor touch.
- **"Already open" means `state.source === 'stored'`, not a model-id match.** When the *file's* copy
  is on screen, the row for the same model id is a different history — the case
  `04-versioning.md` §6 exists for — so opening it is a real move and marking it as current would be
  wrong.

### The embedded history and a stored copy are two switcher entries

**Interpretation.** They are two different histories sharing a model id — the situation `04-versioning.md`
§6 exists for — and merging them into one row would leave whichever history the row was not showing
unreachable. One consequence: while the file entry is current, the delete affordance is absent even if
a stored copy exists, which is what §4's "absent for the embedded model" asks for.

### Deleting the open model does not re-record the embedded history

**Interpretation.** Returning to the embedded data would otherwise call the same write boot performs
and put the deleted copy straight back within the page load. The next time the file is opened, the
embedded model is recorded again — a consequence of opening a file, not a way round the delete.

### Stashes are session-scoped

**Interpretation.** `05-storage.md` §2 lists no stash key, `keysFor` has none, and a `:stash` key would
parse as `kind: 'unknown'`. A stash exists to let *this* reconcile or *this* model switch proceed and
is offered back immediately after; persisting it would change a closed storage layout.

### The collapsed rail shows a monogram, not a clipped label

**Interpretation.** Carbon's 3rem rail assumes an icon set; `07-ui.md` §3 specifies no icons for
sections. `00-app.css` originally clipped the real label to the rail's width, which is not a label at
3rem — it is a column reading `Ris`, `Ris`, `CIA`, `Tru` at exactly the two widths where the rail is
the default, which is the unfinished-looking nav the same stylesheet's button reset was written to
avoid, one breakpoint further down.

The rail now carries a 2–3 letter monogram per row, computed in `17-shell.js` from the words of the
section name and de-duplicated within the tab (`Threat Risk Inputs` and `Trust Ratings` both reduce to
`TR`, and a rail of two identical glyphs would be worse than the clipping it replaced). Three letters
is the cap: at 3rem a fourth is not a glyph any more, and every collision in the current section list
resolves within it.

The monogram is `aria-hidden` decoration. The real label is still in the row — clipped, not
`display: none`d, so it survives in the accessibility tree — and the row also carries the label as its
`title`, so the name is reachable without reading it. No icon vocabulary was invented for the CSS to
then have to match; if icons are ever specified for sections, this is the entry that becomes obsolete.

### Delegated listeners are on `document.body`

**Interpretation**, and a specific exclusion: clicks inside `#tmv-layers` are not handled by the shell
delegation. A modal is a self-contained interaction, and the commit dialog's Commit button reuses
`data-action="commit"`, which would otherwise be read twice — once by the dialog and once by the shell.

### `mount()` refuses before adopting any state

**Interpretation.** A page missing `#tmv-content`, `#tmv-tabs` or `#tmv-side-nav` throws `SHELL_FRAME`
with nothing half-applied. The static markup the shell requires in `src/index.html` is `#tmv-tabs`,
`#tmv-side-nav`, `#tmv-sidenav-trigger`, `#tmv-model-switcher`, `#tmv-header-actions`, `#tmv-content`,
and — because `forms.setDirty` reaches for them by id — `#tmv-dirty`, `#tmv-dirty-text` and
`#tmv-commit`.

### `edit()` validates its argument structurally

**Interpretation.** `modelId` must be a non-empty string or it throws `SHELL_MODEL`. `M.update` returns
the *entity* it changed, not the model, so a view that wrote `shell.edit(M.update(...))` would replace
the working copy with one entity and show up much later as a screen rendering nothing.

### `themeTarget()` falls back to `document.body`

**Test-only tolerance.** The test DOM models `documentElement` as a layout stand-in with no
`setAttribute`; a theme that landed nowhere would be unobservable in a unit test. In a browser the
root is always an element.

### The side nav's first-run state is derived from the viewport (`07-storage.js`)

**Interpretation.** `07-ui.md` §7 gives the side nav a different default at each breakpoint: expanded
at `lg` and above, a 3rem rail at `md`, a drawer opened from the header trigger at `sm`. `00-app.css`
implements the rail and the drawer from the two state classes, so the only thing missing was the
*initial value* of the persisted flag — and it defaulted to expanded at every width. A narrow window
therefore opened with the side nav out (a column at `md`, an overlay covering the content at `sm`) while
the header trigger reported it closed, because the trigger only knows about the collapsed state; the two
could not agree, and `e2e.ui.responsive` caught it as an `aria-expanded` that never moved.

`defaultPrefs()` now computes that initial value from the viewport: below Carbon's 1056px `lg`
breakpoint the side nav starts collapsed. A stored preference wins thereafter (`REQ-UI-003` AC3), which
means the first preference write records whatever the viewport suggested at that moment. A resize
deliberately does not re-derive it: the CSS gives whichever state is current a rail above `sm` and a
drawer below, so every width stays usable, and collapsing on a resize would silently overwrite a choice
the user made. With no measurable viewport — the unit harness's stub document — it answers expanded, so
the unit tests keep exercising the wide layout.

### The build record is written by the export and read by `name` (`18-views-shared.js`, `01-core.js`)

**Correction**, and two defects in one place, both of the kind that had no failing test because the
wrong answer was invisible rather than absent. They were found by the end-to-end suite and are now
asserted there.

- No export path passed a `build` descriptor, so every file the application exported recorded
  `appHash: null`. That made `19-boot.js`'s foreign-build notice — the one that tells a reader this
  file was made by a different build — unreachable for the application's own exports, because the check
  needs a declared hash to compare with the running one. Exports now write the running build's version
  and hash, read from the document's own meta elements, and `generatedAt` is still stamped by the
  container at the moment of export.
- The About panel read those same metas with `core.byId`, but the build writes them as
  `<meta name="tmv-app-hash" …>` with no `id` — so the panel reported "not recorded" and "not stated"
  on a page that had recorded both, and went on to explain the absence with a claim that was false. The
  lookup is now `core.metaContent(name)`, which is what the markup has always supported, and
  `e2e.matrix.browser` asserts that the panel names the declared hash and that the two agree.

---

## Styling and responsive layout

`src/styles/00-app.css` is the only stylesheet the application owns; everything else is Carbon's,
delivered from the pinned CDN. These are the places where matching `07-ui.md` §7 — and looking like a
finished application while doing it — needed a decision the spec does not spell out.

### Type and spacing are fluid, and the root font size deliberately is not

**Interpretation.** REQ-UI-006 asks for readability at 320px and a usable layout at every width above
it. The stylesheet answers with one fluid scale: every text size and the page gutter, block spacing and
card spacing interpolate between their 320px and 1600px values, so a 1100px window is not the 320px
layout with slack in it. Each is written `min + slope·vw` inside a `clamp()`, because a bare `vw` size
collapses toward zero on a narrow window and the floor has to be a real floor.

What is *not* on the scale is deliberate. The root font size stays at the browser default: Carbon's
component metrics are `rem`-based, so a fluid `html { font-size }` would rescale every button, tag,
checkbox and table cell away from the design system's own proportions — the one thing this application
does not control and should not be seen to. `--tmv-header-h` stays 3rem because `e2e/shell.spec.mjs`
asserts the header is exactly 48px, and `--tmv-nav-w` stays 16rem because Carbon's off-canvas rule is
literally `translateX(-16rem)` and a fluid nav would peek out from under it.

### Tables get their width back, and only one of the four is a scroller

**Interpretation.** At `md` the wide tables — the log's nine columns, stashes, the storage model list —
were wider than their own block and spilled past it. Three of the fixes are not a scroller at all:

- Blocks that hold a table take `tmv-settings__block--wide`, which lifts the 48rem *reading* measure
  that the prose blocks around them keep. A table is not prose and does not want a prose measure.
- Cell padding is halved from 1rem to 0.5rem across the `md` range, which is where those columns are
  tightest and where the 100px it returns is worth the most.
- `overflow-wrap: anywhere` is applied to `td` and deliberately not to `th`. In a table laid out
  automatically a column's width is bounded below by the widest thing in it that cannot be broken, and
  one commit message containing `otm_EXAMPLE.json` was 158px of the log's 824px. `anywhere` is the tool
  for that and `break-word` is not: only `anywhere` reduces the column's *minimum* contribution. It is
  invisible where there is room and breaks only where there is none — but headers are chosen words and
  short, and applying it there produced `Messag/e` and `Au/tho/r` on a table with room to spare.

Those three are not enough, and it is worth recording why, because the arithmetic is the whole
argument. With `anywhere` on the cells the table's floor is no longer cells — it is the *headings*,
which deliberately keep their words: about 680px for the log's nine columns. The block that holds them
has the 3rem rail, the page gutter and its own padding taken out of the viewport first, so at 832px the
block is 686 and the table fits, and at 672px it is 542 and the table overruns the page by 96px. There
is a band of roughly 160px where no amount of wrapping helps and where cards are not yet the answer.

Inside that band — and only there, `min-width: 42rem` and `max-width: 51.98rem` — the table scrolls
inside `.tmv-table__scroll`, a wrapper around the table *alone*, added by `dataTable` in
`12-widgets.js`. Making `.tmv-table` the scroller would have put the toolbar and the pagination in the
scrollport with it, so the reader scrolling the table sideways would take the search box out of view
with it. Outside the band the wrapper has no styles at all and lays the table out exactly as the flex
column did before it existed.

The cost is the sticky header, and it is paid honestly rather than hidden: an `overflow-x: auto` box is
a scrollport even when it is not currently scrolling, so `thead th` sticks to *it* rather than to the
page, and the header scrolls away with the rows. Outside the band there is no scrollport and the header
is sticky again, including every width where the log is long enough for that to be worth something.

### A card is as tall as its fields, not as tall as Carbon's body row

**Correction.** At `sm` an entity table's row becomes a card. The cells stacked correctly — the card
was drawn with all nine of its label/value pairs — but Carbon's `.cds--data-table tr` is
`block-size: 3rem`, and our rule made the row `display: block` without undoing that height, so the
row's *box* stayed 48px while its content ran to 245. The pagination bar is the next thing in the
column, so it was laid out 4px below a 48px row and drawn straight across the middle of the card: on a
phone, every entity table showed a card whose fields disappeared under the bar beneath it.

`block-size: auto` on the row inside the `sm` block fixes it, and the bug is worth the entry because
nothing about it was visible at any desktop width and the card *looked* right in a screenshot taken
after scrolling — the fields were there, they were simply painted outside their own box.

### The content switcher wraps, rather than hiding its own labels

**Deviation** from Carbon's rendering, not from any requirement — and the one place in this work where
the clunky screen was Carbon's doing rather than ours.

Carbon draws the content switcher as a single flex row of fixed height, `justify-content: space-evenly`,
with every button at `inline-size: 100%`. That last declaration is what makes it a *selector* rather
than a wrapping list: all four buttons claim the whole width, all four shrink equally to fit, and
because `.cds--content-switcher__label` is `white-space: nowrap` with `text-overflow: ellipsis` inside a
button that is `overflow: hidden` — which gives a flex item an automatic minimum size of zero — the
shrink does not stop at the text. The label is simply cut off.

On our two longest switchers that is not a cosmetic problem. Settings → Export offers four formats, and
"Native container (model and history)" needs 234px of text in a quarter of a 700px block; Carbon drew
that row as "Standalone appl…", "Native container (m…", "Open Threat Model" and "OWASP Threat Model L…",
**at 1440px exactly as at 320px** — three of four options unreadable, on the one control whose entire
job is to say which format is which. Appearance → Theme does the same below 390px, where "Gray 10" and
"Gray 90" both become "Gray …" and the two dark variants cannot be told apart. Neither is a width we
introduced; both are what the control does when handed a label longer than a quarter of its row.

Three declarations fix it, in `00-app.css` §19: the container is `flex-wrap: wrap` with
`block-size: auto`, the button is `flex: 1 1 auto` at `inline-size: auto`, and the label wraps rather
than clips. Each option then takes its own text as its base width and grows to fill whatever row it
lands on. A row that already fits is unchanged — Appearance → Theme on a desktop still reads exactly as
Carbon drew it, four chips in one row — and a row that does not takes two lines or moves to a second
row rather than losing a word. At 320px the export switcher becomes four full-width rows and the theme
switcher three-plus-one; both are readable, which neither was before.

Specificity is the one thing to keep in mind when editing this: Carbon's rule is
`.cds--content-switcher:not(.cds--content-switcher--icon-only) .cds--content-switcher-btn`, and a bare
`.cds--content-switcher-btn` override silently loses to it. The override copies the `:not(...)` so the
two are equal and document order decides. `07-ui.md` §5 records this against the component and §7
against the layout.

`e2e.ui.responsive` guards it, and it is the only place that could: `test/lib/dom.mjs` has no box model,
so a unit test can see that the label element was created and never that it fits. The assertion measures
each label against itself rather than the page against the viewport — a control that clips its own
options is exactly the failure the page-level overflow checks cannot see — and it was falsified by
restoring Carbon's three declarations on the running page, which puts all four theme labels back into
the clipped list and fails the test.

### The progress indicator is ours to lay out

**Deviation** from Carbon's rendering, not from any requirement. `.cds--progress` expects each step to
carry a marker `svg` that it positions against, and places `.cds--progress-optional` absolutely inside
an 8rem step with no width cap — a one-line detail beside a three-word label is wider than that, and
ran down through the report table below it. It also gave the page horizontal overflow at 320 and 390px,
which REQ-UI-006 AC2 forbids.

`tmv-progress` overrides it: a two-column grid per step, the marker drawn as a CSS `::before` keyed to
a `data-state` attribute, the detail back in flow, and the steps wrapping rather than overflowing. The
Carbon state classes are still applied, so the semantic classes and `data-state` agree rather than one
replacing the other. `07-ui.md` §5 records this against the component.

### The header's light/dark switch, and what it remembers

**Interpretation.** `07-ui.md` §4 lists four appearance options in the Appearance settings. Those are
the *variants*; the header control is a two-state switch between the light and dark *families*, which
is what a reader reaching for a sun/moon control expects, and it is a `role="switch"` with
`aria-checked` rather than a fifth menu entry for the same reason.

It remembers the last variant used in each family for the session, so returning to light gives back the
light variant that was chosen rather than resetting to Gray 10. That memory is session-only and
deliberately not persisted: it is not a preference the user expressed, and `REQ-UI-003`'s stored
preference key holds the theme actually in use.

Below `sm` the switch is not rendered. At 320, 360 and 390px the header's last action already ends
exactly at the viewport's right edge, so there is nothing to put it in without either overflowing the
page (REQ-UI-006 AC2) or evicting an action that does something. The four-way choice in Appearance
covers every variant at every width, and the theme can be changed there.

---

## Compare and merge

`16-compare.js` makes several choices `04-versioning.md` §6 does not cover directly. All are
**interpretations**, and the ones that matter are:

- A conflict offers the *ancestor* value as a third option (`[A] [B] [Base]`); §6 shows only `[A] [B]`.
  Declining to pick a side is a real answer, and the ancestor is what the field was before either side
  touched it.
- The default filter is labelled "Needs a decision" / "Everything", not "conflicts only". Deletions
  also need a decision and are not conflicts, so a literally conflicts-only filter would leave Merge
  disabled with no visible reason.
- Model-level object fields (`scope`, `metadata`, `x`) are one slot each, decided as a whole. Per-key
  granularity is not in v1.
- `position` and `size` on a representation element are one `layout` slot (the same reasoning as the
  geometry entry above). Two sides moving and resizing — disjoint sub-fields — get a `Both` option
  that combines them; overlapping changes are a real conflict.
- Derived fields (`score`, `level`) are never decision slots, because two sides changing different
  inputs would raise a conflict on a field nobody edited. They are shown read-only when the sides
  disagree, recomputed from the resolved inputs when any side recorded them, and not invented when no
  side did.
- A deletion of a whole entity is one *existence* decision, not one decision per field: a side that
  does not carry the entity is not a side that deleted each of its fields. A field deleted on one side
  and untouched on the other is an explicit decision with no suggestion — a deletion is never a
  default.
- `plan.carried` exists because the differences alone do not rebuild the model. A merge built only from
  the groups was found to delete every entity neither side had touched.

---

## The test suite

### Citations come from three places, not one (`test/lib/spec.mjs`)

`REQ-*` `- **Test:**` lines are the primary source. Two documents also name suite tests in explicit
tables — `05-storage.md` §9 and `06-interchange.md` §11 — and those tests are no less asked for.
Reading only `01-requirements.md` would push them into the orphan list, which is where tests *nobody*
asked for belong; a list that is wrong is a list people learn to route around. `09-testing.md` §3 has
been amended to say so.

### Browser tests declare themselves the same way (`test/lib/check.mjs`)

The browser specs run under Playwright, not `node --test`, so they call `e2eTest(name)` rather than
`specTest(name, fn)`. It applies the identical name check and returns the name for Playwright's runner.
One rule, two runners.

### The browser specs live in `e2e/`, and the traceability collector reads them there

**Correction** — `09-testing.md` §3 has been amended to name the directory the specs are in.
`02-architecture.md` §3's file list already had `e2e/*.spec.mjs`; §3's prose said `test/e2e/`, and the
two could not both be right.

`node --test` with no path arguments imports every `.js`/`.mjs` under any directory named `test/`, so a
Playwright spec kept there would be imported by the unit runner — which has no `test` fixture to give it
and no browser to run it in. The specs therefore sit beside `test/` rather than inside it, with
`playwright.config.mjs` pointing at them and `e2e/serve.mjs` providing the HTTP half of the protocol
matrix.

The consequence had to be handled rather than accepted. `09-testing.md` §3's collector read `test/`
alone, so the ten `e2eTest(…)` names were reported as cited and defined nowhere. A rule about the suite
is not a rule about a directory, so `testFiles()` in `test/traceability.test.mjs` now reads both roots.
The same file's "the collector is not silently finding nothing" guard is what makes the failure mode
safe in the other direction: a second root that stopped being read would show up as a drop in the
collected-name count rather than as perfect traceability.

### The exemption list is `EXEMPT` in `test/lib/spec.mjs`

`09-testing.md` §3 originally placed the list in `test/traceability.test.mjs` beside the assertion that
reads it. **Correction**, and §3 has been amended: both the name check in `check.mjs` and the
traceability assertion need it, so it lives in `spec.mjs`, which both import. It is still one entry —
`store.no-test-hooks-in-release` — and two further assertions guard it: every exempt name must still be
a test that exists, and the traceability test's own cases are declared with `node:test` under ordinary
prose names rather than exempted, so the list cannot grow to cover the checker.

### `09-testing.md` §4's path is realised in two places, and two of its steps mean something else

`e2e/journey.mjs` is the whole of §4's path — *open file → view model → edit → commit → export HTML →
reopen export in a clean profile → reconcile → edit → export → import into the first profile → compare →
merge* — as one function, so that `e2e.matrix.protocol` runs the same journey on both protocols rather
than two copies that drift. Two of its steps are realised differently from how the sentence reads, and
both are the application's own design rather than a shortcut:

- **"reopen in a clean profile"** is a second browser *context*, not a second tab. Storage is per origin
  and per file path (`05-storage.md` §4), so a second tab would share the first one's store and the step
  would prove nothing about a file arriving from elsewhere.
- **"import into the first profile → compare → merge"** is two steps, because the import screen and the
  reconcile path answer the question differently and the spec requires both answers. Importing a
  container that names a model this browser already has raises `REQ-IMP-006`'s prompt — replace, or
  import as a new model — and *nothing is merged either way*, which the prompt says in as many words.
  The comparison and the merge belong to `REQ-SYNC-005` and `REQ-VCS-009`, which route a file whose
  history has **diverged** to the compare view when it is opened. So the journey does both: it imports
  the second export and asserts the prompt, then opens it and merges. A journey that did only the second
  would be skipping the step §4 names; one that did only the first would never reach the merge.

`e2e.conflict.prompt` is the second path in full, with the assertions in the other direction: it is the
one that checks that opening a diverged file writes nothing, that dismissing leaves both histories and
the working copy untouched, and that confirming is the only thing that moves the head.

---

## Not done, or not verifiable here

- **Firefox cannot be launched in this environment.** The Playwright browsers are installed and
  Chromium and WebKit both run, so the browser matrix in `REQ-SHELL-005` is checked in two engines
  rather than three; `e2e.file-protocol.firefox` skips itself with the launcher's own first line as its
  reason rather than passing quietly, and `e2e.matrix.browser` records which engines it managed to check
  in a test annotation. The requirement that suffers is `REQ-SYNC-008`, whose whole subject is that the
  notice appears *because* the browser is Firefox: `sync.partition-detected` covers the same branch in
  the unit harness with `isFirefox: true`, and the disclosure's wording is asserted there, but the claim
  "a real Firefox shows this" is not verified on this machine and is not claimed anywhere.

  That skip cost more than it looked like it would, and the shape of the cost is worth recording. Boot
  read the registry *after* `seedRegistry` had written the file's own entry into it, so the
  `registryEmpty` half of the heuristic was false on every load, in every browser: the
  `FILE_ORIGIN_PARTITIONED` branch was unreachable in the shipped code, and `REQ-SYNC-008` AC1 could
  never be satisfied. Nothing in the unit suite could see it — `store.origin-partitioned` and
  `sync.partition-detected` both call `detectStorageContext` by hand, so they assert the classifier
  answers correctly without ever asking whether boot supplies the right input — and the one test that
  drives real boot on a real Firefox is the one that skips here. That test was failing on CI, which
  provisions Firefox and does launch it — on the first job the pipeline ever ran, and on every run of
  this branch since. Two changes: boot now reads the registry as it found it, before seeding, and
  `sync.partition-detected` drives the real open path with the engine and protocol supplied the way the
  platform supplies them, so the wiring is covered where the engine is not
  available. The skip remains, and the honest reading of it is unchanged: the branch is verified in a
  Firefox *user agent* and not in a Firefox.

  The same test held a second, quieter defect. It addressed the banner's action as
  `[data-action="export-now"]`, but a notification's actions all carry
  `data-action="notify-action"` and name *which* one in `data-value` — the component owns "a click
  landed on one of my actions" and the shell branches on the value, which is the same shape toasts use.
  So the locator matched nothing and `toBeGreaterThan(0)` would have failed as well. It never ran: the
  assertion above it failed first, and a test that fails at its third line does not report its fifth.
  One defect standing in front of another is why the selector survived review on a branch where the
  case had never once passed.
- **V1–V4 in `09-testing.md` §6 remain unverified** — whether a JSON script block is exempt from a
  hash-only `script-src` on `file://`; whether `<meta>`-delivered CSP is enforced on `file://`; the
  actual state classes in the pinned Carbon stylesheet; and the pinned Mermaid version's
  `securityLevel` and `htmlLabels` defaults. None of these can be answered from Node, and each could
  invalidate part of the design. They are listed there rather than guessed at here. Two of them are now
  *partly* exercised by the browser tests — `e2e.csp.tampered-script-blocked` shows a hash-only policy
  being enforced from a `<meta>` element on `file://` in Chromium, and it also shows the JSON data block
  surviving that policy — but one engine on one platform is evidence, not an answer, and the entries
  stay open until they are answered as such.
- **`REQ-VIEW-009`'s performance budget** is asserted against a threshold chosen for this machine. It is
  a real measurement, not a structural property, and the threshold is where it is for the reason the
  comment beside it gives.
- **`node --test` has failed a test *file* twice in sixteen runs, both times while another full suite
  or a Playwright run was competing for the machine.** The failure carries no assertion and no stack:
  `node --test` runs each file in its own child process and reports a whole-file `✖` whose only message
  is `'test failed'`, which is what a child that died without reporting looks like from the parent. The
  fourteen runs after the second failure — eleven of them consecutive with nothing else running — were
  167/167 with the same files unchanged, and every file involved passes on its own, so this is recorded
  as an observation about running the suite under load on this machine rather than as a failing test.
  It is not diagnosed: a suite that fails silently once in eight runs is not a suite anyone should
  trust without knowing it, and the honest position is that the cause is unknown rather than that it is
  benign.
