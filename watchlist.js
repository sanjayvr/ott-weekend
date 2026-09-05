(() => {
  const SAVED_KEY = "weekendWatch.saved.v1";
  const PHRASE_KEY = "weekendWatch.syncPhrase.v1";
  const NAME_KEY = "weekendWatch.syncListName.v1";
  const PENDING_KEY = "weekendWatch.pendingOps.v2";
  const API = "/api/watchlist";

  const $ = id => document.getElementById(id);

  const savedList = $("savedList");
  const savedEmpty = $("savedEmpty");
  const savedCount = $("savedCount");
  const toWatchList = $("toWatchList");
  const watchedList = $("watchedList");
  const toWatchCount = $("toWatchCount");
  const watchedCount = $("watchedCount");

  if (!savedList || !savedEmpty || !savedCount) return;

  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "");
      return value ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function readSaved() {
    const value = readJson(SAVED_KEY, []);
    return Array.isArray(value) ? value : [];
  }

  function writeSaved(items) {
    return writeJson(SAVED_KEY, items);
  }

  function readPending() {
    const value = readJson(PENDING_KEY, []);
    return Array.isArray(value) ? value : [];
  }

  function writePending(value) {
    return writeJson(PENDING_KEY, value);
  }

  function getPhrase() {
    return localStorage.getItem(PHRASE_KEY) || "";
  }

  function getListName() {
    return localStorage.getItem(NAME_KEY) || "";
  }

  function normalizePhrase(value) {
    return String(value || "")
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function validPhrase(value) {
    const phrase = normalizePhrase(value);
    return phrase.length >= 8 && phrase.length <= 80;
  }

  function saveConnection(phrase, name = "") {
    localStorage.setItem(PHRASE_KEY, phrase);
    localStorage.setItem(NAME_KEY, name);
  }

  function clearConnection() {
    localStorage.removeItem(PHRASE_KEY);
    localStorage.removeItem(NAME_KEY);
    localStorage.removeItem(PENDING_KEY);
  }

  function setMessage(text = "", error = false) {
    const el = $("syncMessage");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("error", Boolean(error));
  }

  async function api(phrase, method = "GET", body = null) {
    const options = {
      method,
      headers: {
        "X-WW-Sync-Phrase": phrase,
        Accept: "application/json"
      }
    };

    if (body !== null) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    const response = await fetch(API, options);

    let data = {};
    try {
      data = await response.json();
    } catch (_) {}

    if (!response.ok) {
      const error = new Error(
        data.error || `Sync failed (${response.status}).`
      );
      error.status = response.status;
      throw error;
    }

    return data;
  }

  function cardTitle(card) {
    return (
      card.querySelector(".release-title")?.textContent ||
      card.querySelector(".pick-title")?.textContent ||
      ""
    ).trim();
  }

  function richCardFor(id) {
    return (
      Array.from(document.querySelectorAll("article.release"))
        .find(card =>
          !card.closest("#panel-saved") &&
          card.dataset.saveId === id
        ) ||
      Array.from(document.querySelectorAll("article.top-pick"))
        .find(card => card.dataset.saveId === id)
    );
  }

  function serialize(card, prior = null) {
    const id = card.dataset.saveId;
    const source = richCardFor(id) || card;
    const verdict = source.querySelector(".verdict");

    return {
      id,
      title: cardTitle(source) || cardTitle(card),
      kind: source.dataset.kind || card.dataset.kind || "movie",
      meta: (
        source.querySelector(".release-meta")?.textContent ||
        source.querySelector(".meta")?.textContent ||
        prior?.meta ||
        ""
      ).replace(/\s+/g, " ").trim(),
      ratings: Array.from(source.querySelectorAll(".score")).length
        ? Array.from(source.querySelectorAll(".score")).map(score => ({
            label: (
              score.querySelector(".score-label")?.textContent || ""
            ).trim(),
            value: (
              score.querySelector(".score-value")?.textContent || ""
            ).trim()
          }))
        : (prior?.ratings || []),
      summary: (
        source.querySelector(".release-summary")?.textContent ||
        source.querySelector(".summary")?.textContent ||
        prior?.summary ||
        ""
      ).replace(/\s+/g, " ").trim(),
      verdict:
        verdict?.textContent?.trim() ||
        prior?.verdict ||
        "Saved",
      verdictClass:
        Array.from(verdict?.classList || [])
          .find(name => name !== "verdict") ||
        prior?.verdictClass ||
        "",
      poster:
        source.querySelector(".poster-shell")?.dataset.poster ||
        prior?.poster ||
        "",
      hue:
        source.querySelector(".poster-shell")?.style
          .getPropertyValue("--poster-hue") ||
        prior?.hue ||
        "30",
      edition:
        document.body.dataset.edition ||
        prior?.edition ||
        "",
      editionLabel:
        document.body.dataset.editionLabel ||
        prior?.editionLabel ||
        "",
      sourceUrl:
        document.body.dataset.permalink ||
        prior?.sourceUrl ||
        location.href.split("#")[0],
      savedAt: prior?.savedAt || new Date().toISOString(),
      watched: Boolean(prior?.watched),
      watchedAt: prior?.watchedAt || null
    };
  }

  function queueState(item, saved = true) {
    const pending = readPending()
      .filter(operation => operation.id !== item.id);

    pending.push({
      id: item.id,
      saved,
      watched: saved && Boolean(item.watched),
      watchedAt: saved ? item.watchedAt || null : null,
      item: saved ? item : null
    });

    writePending(pending);
  }

  async function flushPending() {
    const phrase = getPhrase();

    if (!validPhrase(phrase) || !navigator.onLine) return;

    const pending = readPending();
    if (!pending.length) return;

    for (let index = 0; index < pending.length; index++) {
      const operation = pending[index];

      try {
        await api(phrase, "POST", {
          action: "set",
          id: operation.id,
          saved: operation.saved,
          watched: operation.watched,
          watchedAt: operation.watchedAt,
          item: operation.item
        });
      } catch (error) {
        writePending(pending.slice(index));
        throw error;
      }
    }

    writePending([]);
  }

  async function pullCloud({ quiet = false } = {}) {
    const phrase = getPhrase();

    if (!validPhrase(phrase) || !navigator.onLine) return;

    if (!quiet) setMessage("Syncing…");

    await flushPending();

    const data = await api(phrase, "GET");
    const items = Array.isArray(data.items) ? data.items : [];

    writeSaved(items);

    if (typeof data.displayName === "string") {
      localStorage.setItem(NAME_KEY, data.displayName);
    }

    renderSaved();
    syncButtons();
    renderConnection();

    if (!quiet) setMessage("Up to date.");
  }

  function toggleSave(card) {
    const items = readSaved();
    const id = card.dataset.saveId;
    const index = items.findIndex(item => item.id === id);

    if (index >= 0) {
      const removed = items[index];
      items.splice(index, 1);
      writeSaved(items);
      queueState(removed, false);
    } else {
      const record = serialize(card);
      items.unshift(record);
      writeSaved(items);
      queueState(record, true);
    }

    renderSaved();
    syncButtons();

    if (validPhrase(getPhrase())) {
      flushPending()
        .then(() => setMessage("Synced."))
        .catch(() =>
          setMessage(
            "Saved locally — cloud sync will retry.",
            true
          )
        );
    }
  }

  function setWatched(id, watched) {
    const items = readSaved();
    const item = items.find(record => record.id === id);

    if (!item) return;

    item.watched = Boolean(watched);
    item.watchedAt = watched
      ? new Date().toISOString()
      : null;

    writeSaved(items);
    queueState(item, true);

    renderSaved();
    syncButtons();

    if (validPhrase(getPhrase())) {
      flushPending()
        .then(() => setMessage("Synced."))
        .catch(() =>
          setMessage(
            "Updated locally — cloud sync will retry.",
            true
          )
        );
    }
  }

  function makeText(tag, className, value) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = value || "";
    return el;
  }

  function makePoster(record) {
    const wrap = document.createElement("div");
    wrap.className = "release-poster";
    wrap.setAttribute("aria-hidden", "true");

    const shell = document.createElement("div");
    shell.className = "poster-shell";
    shell.style.setProperty(
      "--poster-hue",
      record.hue || "30"
    );

    const fallback = makeText(
      "div",
      "poster-fallback",
      record.title
    );

    const caption = makeText(
      "div",
      "poster-caption",
      record.title
    );

    shell.append(fallback, caption);

    if (record.poster) {
      const img = document.createElement("img");
      img.className = "poster-image";
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = record.poster;

      img.addEventListener("load", () => {
        fallback.style.visibility = "hidden";
      });

      img.addEventListener("error", () => {
        img.remove();
      });

      shell.prepend(img);
    }

    wrap.append(shell);
    return wrap;
  }

  function makeRatings(record) {
    const grid = document.createElement("div");
    grid.className = "ratings-grid";

    (record.ratings || []).forEach(rating => {
      const score = document.createElement("span");
      score.className = "score";

      score.append(
        makeText(
          "span",
          "score-label",
          rating.label
        ),
        makeText(
          "span",
          "score-value",
          rating.value
        )
      );

      grid.append(score);
    });

    return grid;
  }

  function makeSavedCard(record) {
    const article = document.createElement("article");
    article.className =
      "release" +
      (record.watched ? " saved-watched" : "");

    article.dataset.kind = record.kind || "movie";
    article.dataset.saveId = record.id;

    article.append(makePoster(record));

    const content = document.createElement("div");
    content.className = "release-content";

    content.append(
      makeText(
        "div",
        "release-title",
        record.title
      ),
      makeText(
        "div",
        "release-meta",
        record.meta
      )
    );

    if (record.ratings?.length) {
      content.append(makeRatings(record));
    }

    article.append(content);

    article.append(
      makeText(
        "div",
        `verdict ${record.verdictClass || ""}`.trim(),
        record.verdict || "Saved"
      )
    );

    article.append(
      makeText(
        "div",
        "release-summary",
        record.summary
      )
    );

    const actions = document.createElement("div");
    actions.className = "saved-item-actions";

    const watched = document.createElement("button");
    watched.type = "button";
    watched.className = "watch-button";
    watched.setAttribute(
      "aria-pressed",
      String(Boolean(record.watched))
    );
    watched.textContent = record.watched
      ? "Watched"
      : "Mark watched";

    watched.addEventListener("click", () => {
      setWatched(record.id, !record.watched);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-saved-button";
    remove.textContent = "Remove";

    remove.addEventListener("click", () => {
      toggleSave(article);
    });

    actions.append(watched, remove);
    article.append(actions);

    const source = document.createElement("div");
    source.className = "saved-source";

    const sourcePrefix = record.watched && record.watchedAt
      ? `Watched · saved from ${record.editionLabel || record.edition || "an earlier edition"} · `
      : `Saved from ${record.editionLabel || record.edition || "an earlier edition"} · `;

    source.append(
      document.createTextNode(sourcePrefix)
    );

    const link = document.createElement("a");
    link.href = record.sourceUrl || "/";
    link.textContent = "View edition";
    source.append(link);

    article.append(source);
    return article;
  }

  function renderSaved() {
    const items = readSaved();

    const toWatch = items
      .filter(item => !item.watched)
      .sort((a, b) =>
        String(b.savedAt || "")
          .localeCompare(String(a.savedAt || ""))
      );

    const watched = items
      .filter(item => item.watched)
      .sort((a, b) =>
        String(b.watchedAt || "")
          .localeCompare(String(a.watchedAt || ""))
      );

    savedList.replaceChildren();

    if (toWatchList) {
      toWatchList.replaceChildren(
        ...toWatch.map(makeSavedCard)
      );
    }

    if (watchedList) {
      watchedList.replaceChildren(
        ...watched.map(makeSavedCard)
      );
    }

    if (toWatchCount) {
      toWatchCount.textContent =
        `${toWatch.length} ${toWatch.length === 1 ? "title" : "titles"}`;
    }

    if (watchedCount) {
      watchedCount.textContent =
        `${watched.length} ${watched.length === 1 ? "title" : "titles"}`;
    }

    savedEmpty.hidden = items.length !== 0;

    const toWatchSection = $("toWatchSection");
    const watchedSection = $("watchedSection");

    if (toWatchSection) {
      toWatchSection.hidden = items.length === 0;
    }

    if (watchedSection) {
      watchedSection.hidden = items.length === 0;
    }

    savedCount.textContent = String(items.length);
    savedCount.hidden = items.length === 0;
  }

  function syncButtons() {
    const ids = new Set(
      readSaved().map(item => item.id)
    );

    document
      .querySelectorAll("[data-save-toggle]")
      .forEach(button => {
        const card = button.closest("[data-save-id]");
        if (!card) return;

        const saved = ids.has(card.dataset.saveId);

        button.setAttribute(
          "aria-pressed",
          String(saved)
        );

        button.textContent = saved
          ? "✓ Saved"
          : "+ Save";

        button.setAttribute(
          "aria-label",
          `${saved ? "Remove" : "Save"} ${cardTitle(card)} ${saved ? "from" : "to"} watchlist`
        );
      });
  }

  function maskedPhrase(phrase) {
    const normalized = normalizePhrase(phrase);

    if (normalized.length <= 10) {
      return "••••••••";
    }

    return (
      normalized.slice(0, 4) +
      "••••••" +
      normalized.slice(-3)
    );
  }

  function renderConnection() {
    const phrase = getPhrase();
    const connected = validPhrase(phrase);

    const setup = $("syncSetup");
    const linked = $("syncLinked");
    const setupToggle = $("syncSetupToggle");

    if (setup) setup.hidden = true;
    if (linked) linked.hidden = !connected;
    if (setupToggle) setupToggle.hidden = connected;

    if (connected) {
      $("syncStatus").textContent = navigator.onLine
        ? "Cloud sync enabled"
        : "Cloud sync enabled · currently offline";

      $("syncConnectedName").textContent =
        getListName() || "Shared Weekend Watch list";

      $("syncPhraseMask").textContent =
        maskedPhrase(phrase);
    } else {
      $("syncStatus").textContent =
        "Local to this device";
    }
  }

  async function createList() {
    const name = $("newListName").value.trim();
    const phrase = $("newSyncPhrase").value;

    if (!validPhrase(phrase)) {
      setMessage(
        "Choose a sync phrase between 8 and 80 characters.",
        true
      );
      return;
    }

    setMessage("Creating…");

    try {
      await api(phrase, "POST", {
        action: "create",
        displayName: name
      });

      const localItems = readSaved();

      if (localItems.length) {
        await api(phrase, "POST", {
          action: "merge",
          items: localItems
        });
      }

      saveConnection(phrase, name);

      $("newSyncPhrase").value = "";
      $("newListName").value = "";

      renderConnection();

      setMessage(
        "Cloud sync is ready. Use the same phrase on another device."
      );
    } catch (error) {
      setMessage(
        error.message || "Could not create the list.",
        true
      );
    }
  }

  async function connectList() {
    const phrase = $("existingSyncPhrase").value;

    if (!validPhrase(phrase)) {
      setMessage(
        "Enter a sync phrase of at least 8 characters.",
        true
      );
      return;
    }

    setMessage("Connecting…");

    try {
      const cloud = await api(phrase, "GET");

      const localItems = readSaved();

      if (localItems.length) {
        await api(phrase, "POST", {
          action: "merge",
          items: localItems
        });
      }

      saveConnection(
        phrase,
        cloud.displayName || ""
      );

      $("existingSyncPhrase").value = "";

      await pullCloud({ quiet: true });

      setMessage(
        "Connected. This device now shares the same list."
      );
    } catch (error) {
      setMessage(
        error.status === 404
          ? "No list uses that sync phrase."
          : (error.message || "Could not connect."),
        true
      );
    }
  }

  document
    .querySelectorAll("article.release, article.top-pick")
    .forEach(card => {
      if (card.closest("#panel-saved")) return;
      if (card.querySelector(":scope > .save-button")) return;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "save-button";
      button.dataset.saveToggle = "";
      button.setAttribute(
        "aria-pressed",
        "false"
      );
      button.textContent = "+ Save";

      button.addEventListener("click", () => {
        toggleSave(card);
      });

      const summary =
        card.querySelector(".release-summary");

      if (
        card.classList.contains("release") &&
        summary
      ) {
        card.insertBefore(button, summary);
      } else {
        card.append(button);
      }
    });

  $("syncSetupToggle")?.addEventListener(
    "click",
    () => {
      const setup = $("syncSetup");
      setup.hidden = !setup.hidden;
      setMessage("");
    }
  );

  $("createCloudList")?.addEventListener(
    "click",
    createList
  );

  $("connectCloudList")?.addEventListener(
    "click",
    connectList
  );

  $("existingSyncPhrase")?.addEventListener(
    "keydown",
    event => {
      if (event.key === "Enter") {
        connectList();
      }
    }
  );

  $("copyPhrase")?.addEventListener(
    "click",
    async () => {
      const phrase = getPhrase();

      try {
        await navigator.clipboard.writeText(phrase);
        setMessage("Sync phrase copied.");
      } catch (_) {
        setMessage(
          "Copy your phrase from the setup device."
        );
      }
    }
  );

  $("syncNow")?.addEventListener(
    "click",
    () => {
      pullCloud()
        .catch(error =>
          setMessage(
            error.message || "Could not sync.",
            true
          )
        );
    }
  );

  $("disconnectSync")?.addEventListener(
    "click",
    () => {
      clearConnection();
      renderConnection();

      setMessage(
        "Cloud sync disconnected from this device. The local list is still here."
      );
    }
  );

  window.addEventListener("online", () => {
    renderConnection();

    if (validPhrase(getPhrase())) {
      pullCloud({ quiet: true })
        .catch(() => {});
    }
  });

  window.addEventListener(
    "offline",
    renderConnection
  );

  window.addEventListener(
    "storage",
    event => {
      if (event.key === SAVED_KEY) {
        renderSaved();
        syncButtons();
      }

      if (
        event.key === PHRASE_KEY ||
        event.key === NAME_KEY
      ) {
        renderConnection();
      }
    }
  );

  renderSaved();
  syncButtons();
  renderConnection();

  if (
    validPhrase(getPhrase()) &&
    navigator.onLine
  ) {
    pullCloud({ quiet: true })
      .then(() => setMessage("Up to date."))
      .catch(() =>
        setMessage(
          "Using the local copy — cloud sync will retry.",
          true
        )
      );
  }
})();
