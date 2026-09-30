/**
 * Boot — `02-architecture.md` §6, the eight steps, in order.
 * Requirements: REQ-SHELL-001..007, REQ-DATA-003, REQ-DATA-005, REQ-VCS-002, REQ-VIEW-008,
 * REQ-STORE-003, REQ-STORE-007, REQ-SYNC-001..008, REQ-SEC-005, REQ-EXP-008.
 *
 * This is the only file in the build with load-time side effects, and `build.mjs` excludes exactly
 * this file when it evaluates the others — which is why every module above it can be defined without
 * a document. What it does is the sequence in §6 and nothing else; where the code looks arbitrary,
 * the reason is the order, and each step says why it is where it is.
 *
 * Four decisions shape the file.
 *
 * 1. **The pristine clone is taken first, before anything else runs.** `exporting.capturePristine`
 *    clones `documentElement` as the file was authored, and every export clones *that*. Taken later
 *    it would carry whatever the session happened to be in — a theme class on the root, rendered rows
 *    in the content region, a dirty indicator in the header — and two exports of the same unchanged
 *    model would differ for no reason a reader could point to (REQ-EXP-008 AC2).
 *
 * 2. **Boot is synchronous.** §6 says the work is milliseconds for realistic models, so a progress
 *    skeleton would be a lie about where the time goes. What §6 does require is that the comparison
 *    happens "before the UI becomes interactive" (REQ-SYNC-001 AC1), and a blocking pass is the
 *    strongest form of that: no handler is attached until the reconcile has decided which history is
 *    on screen, so there is no window in which a click meets the wrong one.
 *
 * 3. **Every dead end is a screen, and each screen names its own way out.** A container that does not
 *    parse, a chain that does not verify, and a file written by another build are three different
 *    failures and none of them is recoverable by guessing. Each stops the application with the
 *    navigation hidden, because a tab strip over an empty panel invites the user to hunt for a model
 *    that is not there — and in the parse case the local history for that `modelId` is deliberately
 *    left alone (REQ-DATA-005), so there would be nothing behind the tab strip even if they found it.
 *
 * 4. **The reconcile decides what is mounted, and boot is the only thing that acts on it.** `reconcile`
 *    returns a verdict rather than doing anything, which is what makes REQ-SYNC-005's "reaches the
 *    compare view without writing to storage" a property of the code rather than a promise. The one
 *    write on this path is the adoption REQ-SYNC-002 asks for, and it happens after the decision, not
 *    as part of it.
 */
(function (TMV) {
  'use strict';

  var core = TMV.core;
  var storage = TMV.storage;

  var DATA_ID = TMV.container.BLOCK_ID;
  var APP_HASH_META = 'tmv-app-hash';

  var doc = typeof document === 'undefined' ? null : document;

  // §6 step 1, and the only statement in the application that runs before the document is touched.
  // `capturePristine` on a document that is not there (the build's own `loadNamespace`, a Node test)
  // returns null rather than throwing, which is why this needs no guard of its own.
  TMV.exporting.capturePristine(doc);

  // ---------------------------------------------------------------------------------------------
  // Small readings
  // ---------------------------------------------------------------------------------------------

  function messageOf(err) {
    if (err && core.isString(err.message) && err.message !== '') return err.message;
    return String(err);
  }

  /**
   * The hash this build declares for its own script, out of the head of the page it is running in.
   *
   * Read as an attribute rather than recomputed: the number being checked is "was this model written
   * by a build other than the one now running", and the honest answer to that is a comparison of the
   * two declared hashes. Recomputing our own would tell us something we already know and would make
   * the check depend on being able to measure our own source, which an inline script cannot do.
   */
  function runningAppHash() {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    var meta = doc.querySelector('meta[name="' + APP_HASH_META + '"]');
    if (!meta || typeof meta.getAttribute !== 'function') return null;
    var value = meta.getAttribute('content');
    return core.isString(value) && value !== '' ? value : null;
  }

  function fileAppHash(containerValue) {
    var build = containerValue && core.isObject(containerValue.build) ? containerValue.build : null;
    return build && core.isString(build.appHash) && build.appHash !== '' ? build.appHash : null;
  }

  /**
   * An application hash, shortened for a sentence.
   *
   * `core.shortId` does this for *content addresses*, which are written `sha256:<hex>` and are split
   * on the colon. An application hash is a CSP hash — `sha256-<base64>` — and has no colon at all, so
   * `shortId` returns the whole scheme and no digest: every foreign build would be named identically,
   * which is the one thing the notice exists to distinguish. The two formats differ by one character
   * and mean different things, so they get different functions.
   */
  function shortBuildHash(hash) {
    if (!core.isString(hash) || hash === '') return 'unknown';
    var at = hash.indexOf('-');
    if (at === -1) return hash.slice(0, 7);
    var scheme = hash.slice(0, at);
    var body = hash.slice(at + 1);
    return body === '' ? scheme + '-' : scheme + '-' + body.slice(0, 7);
  }

  /**
   * The model at a history's head, or nothing.
   *
   * `headModel` *throws* when a commit along the chain carries no snapshot or no delta — which is
   * exactly the state a truncated file is in — and that is the case this whole path exists for, so
   * the throw is caught here rather than allowed to escape boot. A boot that threw would leave a page
   * that had cloned its document and rendered nothing: no screen, no explanation, no export.
   */
  function safeHeadModel(history) {
    if (!history || !core.isString(history.head)) return null;
    try {
      var model = TMV.vcs.headModel(history);
      return core.isObject(model) ? model : null;
    } catch (err) {
      return null;
    }
  }

  /** The first few problems of a broken chain, as one sentence. The count is kept so it cannot look total. */
  function chainDetail(problems) {
    var list = core.isArray(problems) ? problems : [];
    if (!list.length) return 'The commit chain in the file does not check out.';
    var first = list[0];
    var text = first && core.isString(first.message) ? first.message : 'A commit did not verify.';
    if (list.length > 1) text += ' (' + core.plural(list.length - 1, 'more problem', 'more problems') + ')';
    return text;
  }

  /**
   * The model id the *file* claims, or null.
   *
   * Deliberately not `shell.currentModelId()`, which prefers the model on screen: every use here is
   * "what does the file say", asked before anything is on screen at all.
   */
  function fileModelId(containerValue) {
    var model = containerValue && core.isObject(containerValue.model) ? containerValue.model : null;
    if (model && core.isString(model.modelId) && storage.isModelId(model.modelId)) return model.modelId;
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // The screens that stop
  // ---------------------------------------------------------------------------------------------

  /**
   * Mount just enough shell to carry a full-screen state, with nothing behind it.
   *
   * No adapter is passed, and that is the point rather than an omission: on this path boot does not
   * yet know whether the storage it would open belongs to this model, and REQ-DATA-005 requires the
   * local history for the affected `modelId` to be left untouched. An adapter that is never created
   * cannot be written to by anything the screen reaches.
   */
  function stop(spec) {
    TMV.shell.mount({
      adapter: null,
      container: null,
      embedded: null,
      model: null,
      history: null,
      editable: false,
      readOnlyReason: null,
      failure: spec,
    });
    return null;
  }

  function parseFailure(raw, detail) {
    return stop({
      title: 'This file cannot be read as a threat model',
      body:
        'The model inside this file is not in a shape this application understands, so it has not been ' +
        'opened. Your browser may still be able to read the file, and the data is not lost — it is ' +
        'text inside the file, and copying it out is enough to recover the model.',
      detail: detail,
      raw: core.isString(raw) && raw !== '' ? raw : null,
      actions: [],
    });
  }

  function missingFieldsFailure(containerValue, raw) {
    var shape = TMV.container.inspect(containerValue);
    return stop({
      title: 'This file is not a Threat-Model-Viewport file',
      body:
        'It opened as JSON, but the fields that identify a threat-model container are not there. ' +
        'Nothing has been read from it and nothing has been written.',
      detail: shape && shape.reason ? shape.reason : null,
      raw: core.isString(raw) && raw !== '' ? raw : null,
      actions: [],
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------------------------

  function run() {
    if (!doc) return null;

    // ---- step 2: read and parse the container -------------------------------------------------

    var dataNode = core.byId(DATA_ID);
    if (!dataNode) {
      return stop({
        title: 'This page carries no threat model',
        body:
          'The element that holds a model is not in this document, so there is nothing to open. This ' +
          'usually means the file was edited by hand, or that only part of it was saved.',
        detail: 'Expected an element with the id "' + DATA_ID + '".',
      });
    }
    var raw = core.isString(dataNode.textContent) ? dataNode.textContent : '';

    var parsed;
    try {
      parsed = TMV.container.parse(raw);
    } catch (err) {
      return parseFailure(raw, messageOf(err));
    }
    var containerValue = parsed.container;

    var shape = TMV.container.inspect(containerValue);
    if (!shape.ok) return missingFieldsFailure(containerValue, raw);

    // ---- step 3: integrity --------------------------------------------------------------------

    var adopted = TMV.vcs.adopt(containerValue.history);
    var fileHistory = adopted.history;
    var chainOk = adopted.verdict.ok === true;
    var chainProblems = chainOk ? [] : adopted.verdict.problems;

    // A chain that does not verify still has to be *shown*: REQ-VIEW-008 asks for read-only, not for
    // a refusal to open. §6's inventory calls that screen "full-screen; read-only; names the commit;
    // offers export", and export is only reachable from an opened model — so the screen's way out is
    // to put the model on screen with every edit affordance removed.
    var model = safeHeadModel(fileHistory);
    if (chainOk && !model) {
      // The chain verified but its head materialises to nothing, which means the commits and the
      // models disagree. There is no read-only view to offer, so this is a stop rather than a mode.
      return stop({
        title: 'The history in this file cannot be reconstructed',
        body:
          'Every commit in this file verifies, but the model they describe cannot be rebuilt from ' +
          'them, so there is nothing to show. The file is unchanged and nothing has been written.',
        raw: raw,
      });
    }

    // ---- step 4: storage ----------------------------------------------------------------------

    // REQ-SEC-005: a file written by another build is not trusted by default. The comparison is
    // between two declared hashes, and an *absent* one on either side is not a mismatch — a file from
    // before the hash was recorded is unknown, not foreign, and treating unknown as foreign would put
    // every hand-made container into read-only mode for a reason that is not true.
    var foreign = null;
    var declared = fileAppHash(containerValue);
    var running = runningAppHash();
    if (core.isString(declared) && core.isString(running) && declared !== running) foreign = declared;

    var readOnly = true;
    var readOnlyReason = null;
    if (shape.readOnly) {
      // An unknown container version. §6's step 2 and REQ-DATA-003: open it read-only with the
      // explanation rather than refuse it — the model may well be readable, and the parts this build
      // does not understand are the parts it must not rewrite.
      readOnlyReason = shape.reason;
    } else if (!chainOk) {
      readOnlyReason =
        'The commit chain in this file does not verify, so it is open read-only. ' + chainDetail(chainProblems);
    } else if (foreign) {
      readOnlyReason =
        'This file was written by a different build of the application (' + shortBuildHash(foreign) +
        '), so it is open read-only until you say otherwise.';
    } else {
      readOnly = false;
    }

    var adapterResult = readOnly
      ? storage.createAdapter({ readOnly: true, refuseReason: readOnlyReason })
      : storage.createAdapter({});
    var adapter = adapterResult.adapter;

    // Asked of the platform directly rather than inferred from `createAdapter`'s notice, because
    // read-only mode legitimately produces no notice while still being unable to write — and the
    // storage-unavailable banner is about the platform's answer, not about our mode.
    var available = storage.localBackend() !== null;

    var migrations = null;
    try {
      migrations = storage.runMigrations(adapter, {});
    } catch (err) {
      // A migration that throws has already been required to write nothing before it removes
      // anything, so the honest thing here is to carry on with what is on disk.
      migrations = null;
    }

    var prefs = storage.readPrefs(adapter);

    // REQ-STORE-003: the registry is seeded from the file on every load, so a cleared store
    // repopulates from the file alone — and never downgrades a stored head that is ahead of the
    // file's, which is the whole reason `seedRegistry` exists as its own function.
    if (!readOnly) {
      try {
        storage.seedRegistry(adapter, containerValue, { filename: null });
      } catch (err) {
        /* a registry that could not be written is rebuilt on the next load; it is an index, not data */
      }
    }

    var registryEntries = [];
    try {
      registryEntries = storage.readRegistry(adapter);
    } catch (err) {
      registryEntries = [];
    }

    var env = storage.environment();
    var storageState = storage.detectStorageContext({
      available: available,
      protocol: env.protocol,
      isFirefox: env.isFirefox,
      registryEmpty: registryEntries.length === 0,
      // The heuristic only bites when the file itself carries history: a file with none has nothing
      // for a partitioned store to have failed to find, and saying otherwise would explain a browser
      // behaviour that did not happen.
      fileHasHistory: core.isArray(fileHistory.commits) && fileHistory.commits.length > 0,
    });

    // ---- step 5: reconcile --------------------------------------------------------------------

    var modelId = fileModelId(containerValue);
    var local = null;
    if (modelId) {
      try {
        local = storage.loadModel(adapter, modelId);
      } catch (err) {
        local = { ok: false, reason: 'threw', message: messageOf(err) };
      }
    }

    var verdict = storage.reconcile({ history: fileHistory, model: containerValue.model }, local);

    var mounted = decideMount({
      verdict: verdict,
      fileHistory: fileHistory,
      local: local,
      model: model,
      readOnly: readOnly,
      chainOk: chainOk,
      chainProblems: chainProblems,
      foreign: foreign,
      readOnlyReason: readOnlyReason,
    });

    // The one write on this path, and it happens *after* the decision rather than as part of it
    // (REQ-SYNC-002). `adopt: true` means the store is behind the file, or has nothing for this
    // model, and the file's history is now the history on screen — so it is recorded locally, which
    // is what makes the local head equal the file's head and what makes a second open identical
    // (REQ-SYNC-004, REQ-SYNC-007). Every other verdict has `adopt: false`, which is what keeps
    // divergence write-free (REQ-SYNC-005 AC1). A refusal here costs nothing: storage is a cache
    // (ADR-0001), the file is still the model, and the next commit records the history anyway.
    if (verdict.adopt === true && mounted.editable && modelId && adapter.writable()) {
      try {
        var adoptedLocal = storage.saveModel(adapter, mounted.history, {
          modelId: modelId,
          name: mounted.model && core.isString(mounted.model.name) ? mounted.model.name : null,
        });
        if (adoptedLocal && adoptedLocal.ok) mounted.writeToken = adoptedLocal.writeToken;
      } catch (err) {
        /* a cache that could not be filled is not an open that failed */
      }
    }

    // ---- steps 6 and 7: render, and attach -----------------------------------------------------

    if (verdict.verdict === storage.DIVERGED) {
      // The user did not ask for this comparison, the file did, so the compare section is where the
      // session opens. The preference is set for this session only and never written: REQ-SYNC-005's
      // acceptance criterion is that the reconcile reaches the compare view *without* writing to
      // storage, and a preference write would be a write.
      prefs.activeTab = 'history';
    }

    TMV.shell.mount({
      adapter: adapter,
      prefs: prefs,
      container: containerValue,
      embedded: storage.embeddedEntry(containerValue, { filename: null }),
      model: mounted.model,
      history: mounted.history,
      writeToken: mounted.writeToken,
      editable: mounted.editable,
      readOnlyReason: mounted.readOnlyReason,
      source: mounted.source,
      storage: storageState,
      compare: mounted.compare,
      failure: mounted.failure,
    });

    if (mounted.compare) TMV.shell.refresh({ section: 'compare' });

    // ---- step 8: report ------------------------------------------------------------------------

    TMV.shell.reportStorage(storageState);
    TMV.shell.reportReconcile(verdict);

    if (foreign) reportForeignBuild(foreign);

    var unrecognised = migrations && core.isArray(migrations.unrecognised) ? migrations.unrecognised : null;
    if (unrecognised && unrecognised.length) {
      TMV.notify.banner({
        key: 'storage-unrecognised',
        level: 'info',
        title: 'Some stored data was left alone',
        body:
          'This browser is holding ' + core.plural(unrecognised.length, 'entry', 'entries') +
          ' this build does not recognise. Nothing was deleted: a value this version does not ' +
          'understand may belong to a newer one, and removing it would destroy work that is not ours.',
      });
    }

    return TMV.shell.state();
  }

  // ---------------------------------------------------------------------------------------------
  // What the reconcile verdict means for what gets mounted
  // ---------------------------------------------------------------------------------------------

  /**
   * Turn the verdict into mount options. Pure, so the five cases can be read as a set.
   *
   * The one that needs explaining is divergence. `compare.plan` looks both heads up in *one* history
   * — it walks the merge base over the history it is handed — so a mount that carried only the local
   * history would make the file's head unfindable and the compare screen would report that one of the
   * two commits is not in the history. The union is therefore what gets mounted, with the local head
   * as its head: the local history is what the session is working from (REQ-SYNC-003's rule that the
   * browser's copy wins is the same rule here), and the file's commits are present so the comparison
   * has both sides to read.
   */
  function decideMount(input) {
    var verdict = input.verdict || {};
    var out = {
      history: input.fileHistory,
      model: input.model,
      editable: input.readOnly !== true,
      readOnlyReason: input.readOnlyReason,
      source: 'file',
      writeToken: null,
      compare: null,
      failure: null,
    };

    // A chain that did not verify is the one case that opens with a screen rather than with content:
    // the model is mounted so the screen has something to offer a way into, and `clear-failure` is
    // what puts it on screen. Read-only is already set, so the way in has no edit affordances.
    if (input.chainOk !== true) {
      out.failure = {
        title: 'The history in this file does not check out',
        body:
          'Every commit is checked against its own hash when a file is opened, and at least one of ' +
          'them does not match, so this file cannot be treated as an unmodified history. It is open ' +
          'read-only: nothing you do here can write to it, and the model can still be read and ' +
          'exported.',
        detail: chainDetail(input.chainProblems) || null,
        actions: input.model ? [{ label: 'Open read-only', kind: 'primary', action: 'clear-failure' }] : [],
      };
      return out;
    }

    if (verdict.verdict === storage.LOCAL_AHEAD || verdict.verdict === storage.DIVERGED) {
      var localHistory = input.local && input.local.ok ? input.local.history : null;
      if (localHistory && core.isArray(localHistory.commits) && localHistory.commits.length) {
        out.history = verdict.verdict === storage.DIVERGED ? unionOf(input.fileHistory, localHistory) : localHistory;
        out.model = TMV.vcs.headModel(out.history);
        out.writeToken = input.local.meta ? input.local.meta.writeToken : null;
        out.source = 'stored';
      }
      if (verdict.verdict === storage.DIVERGED) {
        out.compare = {
          aHead: input.fileHistory.head,
          bHead: out.history.head,
          aName: 'The file',
          aRole: 'The history in the file you opened',
          bName: 'This browser',
          bRole: 'The history stored in this browser',
        };
      }
      return out;
    }

    // `no-local`, `identical`, `embedded-ahead` and `unrelated` all end with the file's history on
    // screen: two of them because there is nothing else, one because the file is ahead, and one
    // because the two histories have nothing in common and are deliberately kept apart.
    return out;
  }

  /**
   * Both histories as one commit set, with the local head as the head.
   *
   * Not `vcs.adopt` over a synthetic object built here: `adopt` sorts and verifies, and it is the
   * same function the file and the store each go through, so a union that reaches the compare screen
   * has been checked exactly as its two halves were.
   */
  function unionOf(fileHistory, localHistory) {
    var merged = {
      keyframeInterval: core.isNumber(localHistory.keyframeInterval)
        ? localHistory.keyframeInterval
        : fileHistory.keyframeInterval,
      head: localHistory.head,
      commits: fileHistory.commits.concat(localHistory.commits),
    };
    return TMV.vcs.adopt(merged).history;
  }

  // ---------------------------------------------------------------------------------------------
  // Reporting the one warning that has a way out
  // ---------------------------------------------------------------------------------------------

  /**
   * REQ-SEC-005: warn first, default to read-only, and let the user acknowledge.
   *
   * The acknowledgement is a banner action rather than a modal, because the file is already open and
   * usable — read-only mode is a mode, not a failure — so a dialog would stop work that is not
   * blocked. The action carries its own `onSelect`, which is what `13-notify.js` wires for exactly
   * this: a notice that changes something when it is acted on does not need the shell to route it.
   */
  function reportForeignBuild(declared) {
    TMV.notify.banner({
      key: 'foreign-build',
      level: 'warning',
      title: 'This file was written by a different build',
      body:
        'The file records that it was produced by the build ' + shortBuildHash(declared) +
        ', and this is a different one. A threat model is a document that can carry more than a model ' +
        '— so a file from another build is treated as untrusted until you say otherwise, and editing ' +
        'is off until then.',
      actions: [
        {
          label: 'Edit anyway',
          kind: 'primary',
          action: 'trust-foreign-build',
          onSelect: function () {
            // `setEditable` clears the read-only banner it raised, which is the whole of what
            // accepting means: the same model, the same history, with the edit affordances back.
            TMV.shell.setEditable(true);
          },
        },
      ],
    });
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * The seam the tests drive. `run` is what the file does on load, and it is exported so an
   * end-to-end test can start the application against a document it built itself rather than having
   * to wait for the load event.
   */
  TMV.boot = {
    run: run,
    runningAppHash: runningAppHash,
    decideMount: decideMount,
    unionOf: unionOf,
  };

  run();
})(globalThis.TMV = globalThis.TMV || {});
