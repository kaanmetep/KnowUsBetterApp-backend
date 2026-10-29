(() => {
  "use strict";

  const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser;
  const $ = (id) => document.getElementById(id);
  const LANGS = ["en", "tr", "es", "pt"];

  const state = {
    categories: [],
    currentCategory: null,
    questions: [],
    weightFilter: "all",
    reversed: false,
    editingId: null,
    localBypass: false,
    pinnedToggles: null,
    pushAudience: null,
    pushUsers: null,
    announcements: [],
    editingAnnouncementId: null,
  };

  // ---------- helpers ----------

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child == null) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  let toastTimer;
  function toast(message, isError = false) {
    const node = $("toast");
    node.textContent = message;
    node.className = `show${isError ? " err" : ""}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (node.className = ""), isError ? 4500 : 2200);
  }

  class ApiError extends Error {
    constructor(message, status, body) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(`api/${path}`, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith("auth/")) {
      showLogin();
    }
    if (!res.ok) {
      throw new ApiError(data.message || `HTTP ${res.status}`, res.status, data);
    }
    return data;
  }

  function withBusy(button, fn) {
    return async (...args) => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await fn(...args);
      } catch (err) {
        if (err?.name === "NotAllowedError") toast("Face ID iptal edildi", true);
        else toast(err.message || "Bir şeyler ters gitti", true);
      } finally {
        button.disabled = false;
      }
    };
  }

  function categoryLabel(category) {
    const base = category.labels?.category_tr || category.labels?.category_en || category.id;
    const difficulty = String(category.difficulty || "").toLowerCase();
    if (difficulty === "hard") return `${base} · Zor`;
    if (difficulty === "intimacy") return `${base} · Yakınlık`;
    if (difficulty === "easy") return `${base} · Kolay`;
    if (difficulty) return `${base} · ${difficulty}`;
    return base;
  }

  // ---------- auth ----------

  function showLogin(status) {
    $("view-app").classList.add("hidden");
    $("view-login").classList.remove("hidden");
    const registered = status ? status.registered : true;
    $("setup-box").classList.toggle("hidden", registered);
    $("btn-login").classList.toggle("hidden", !registered);
    $("login-subtitle").textContent = registered
      ? "Face ID ile giriş yap."
      : "Henüz kayıtlı cihaz yok. Önce bu telefonu kaydet.";
  }

  function showLoginError(message) {
    const box = $("login-error");
    box.textContent = message;
    box.classList.toggle("hidden", !message);
  }

  async function passkeyAssertion(kind) {
    const { challengeId, options } = await api(`auth/${kind}/options`, { method: "POST", body: {} });
    const response = await startAuthentication({ optionsJSON: options });
    await api(`auth/${kind}/verify`, { method: "POST", body: { challengeId, response } });
  }

  async function registerDevice(setupToken, label) {
    const { challengeId, options } = await api("auth/register/options", {
      method: "POST",
      body: { setupToken },
    });
    const response = await startRegistration({ optionsJSON: options });
    await api("auth/register/verify", {
      method: "POST",
      body: { setupToken, challengeId, response, label },
    });
  }

  $("btn-login").addEventListener(
    "click",
    withBusy($("btn-login"), async () => {
      showLoginError("");
      try {
        await passkeyAssertion("login");
      } catch (err) {
        if (err instanceof ApiError) showLoginError(err.message);
        throw err;
      }
      await enterApp();
    }),
  );

  $("btn-register").addEventListener(
    "click",
    withBusy($("btn-register"), async () => {
      showLoginError("");
      const token = $("setup-token").value.trim();
      if (!token) throw new Error("Setup token gerekli");
      try {
        await registerDevice(token, $("setup-label").value.trim() || null);
        toast("Cihaz kaydedildi, şimdi Face ID ile giriş yap");
        $("setup-token").value = "";
        await passkeyAssertion("login");
      } catch (err) {
        if (err instanceof ApiError) showLoginError(err.message);
        throw err;
      }
      await enterApp();
    }),
  );

  $("btn-add-device").addEventListener(
    "click",
    withBusy($("btn-add-device"), async () => {
      const token = prompt("Yeni cihaz için ADMIN_SETUP_TOKEN:");
      if (!token) return;
      await registerDevice(token.trim(), "Ek cihaz");
      toast("Yeni passkey kaydedildi");
    }),
  );

  $("btn-logout").addEventListener("click", async () => {
    await api("auth/logout", { method: "POST", body: {} }).catch(() => {});
    showLogin({ registered: true });
  });

  // ---------- tabs ----------

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === name);
    });
    for (const key of ["list", "form", "sql", "announcements", "push"]) {
      $(`tab-${key}`).classList.toggle("hidden", key !== name);
    }
    window.scrollTo({ top: 0 });
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.dataset.tab === "form" && state.editingId === null) resetForm();
      if (tab.dataset.tab === "push") loadPushAudience().catch((err) => toast(err.message, true));
      if (tab.dataset.tab === "announcements") {
        loadAnnouncements().catch((err) => toast(err.message, true));
      }
      switchTab(tab.dataset.tab);
    });
  });

  // ---------- categories & list ----------

  async function loadCategories() {
    const { categories } = await api("categories");
    state.categories = categories;
    if (!state.currentCategory && categories.length) {
      state.currentCategory = categories[0].id;
    }
    renderChips();
    renderCategorySelect();
    renderPushCategories();
    renderStats();
  }

  // ---------- stats & added counter ----------

  // Per-device (localStorage), so it survives reloads until reset manually.
  const COUNTER_KEY = "kub_admin_added_count";

  function readCounter() {
    return Number(localStorage.getItem(COUNTER_KEY)) || 0;
  }

  function writeCounter(value) {
    localStorage.setItem(COUNTER_KEY, String(value));
    renderStats();
  }

  function renderStats() {
    const total = state.categories.reduce((sum, c) => sum + (Number(c.question_count) || 0), 0);
    $("stat-total").textContent = state.categories.length ? total : "–";
    $("stat-added").textContent = readCounter();
    const selected = $("f-category").value;
    $("stat-categories").replaceChildren(
      ...state.categories.map((category) =>
        el("div", { class: `stat-cat${category.id === selected ? " active" : ""}` }, [
          el("span", { class: "name", text: categoryLabel(category) }),
          el("span", { class: "num", text: category.question_count }),
        ]),
      ),
    );
  }

  $("f-category").addEventListener("change", renderStats);

  $("btn-reset-counter").addEventListener("click", () => {
    if (readCounter() && !confirm("Sayaç sıfırlansın mı?")) return;
    writeCounter(0);
    toast("Sayaç sıfırlandı");
  });

  function renderChips() {
    const wrap = $("category-chips");
    wrap.replaceChildren(
      ...state.categories.map((category) =>
        el(
          "button",
          {
            class: `chip${category.id === state.currentCategory ? " active" : ""}`,
            onclick: () => selectCategory(category.id),
          },
          [categoryLabel(category), el("span", { class: "count", text: category.question_count })],
        ),
      ),
    );
    wrap.querySelector(".chip.active")?.scrollIntoView({ inline: "center", block: "nearest" });
  }

  function renderCategorySelect() {
    const select = $("f-category");
    const previous = select.value;
    select.replaceChildren(
      ...state.categories.map((category) =>
        el("option", { value: category.id, text: `${categoryLabel(category)} (${category.id})` }),
      ),
    );
    select.value = previous || state.currentCategory || "";
    setTrivia($("f-trivia").checked);
  }

  async function selectCategory(categoryId) {
    state.currentCategory = categoryId;
    $("search").value = "";
    renderChips();
    await loadQuestions();
  }

  async function loadQuestions() {
    if (!state.currentCategory) return;
    const list = $("question-list");
    list.replaceChildren(el("div", { class: "empty", text: "Yükleniyor…" }));
    const { questions } = await api(`questions?category=${encodeURIComponent(state.currentCategory)}`);
    state.questions = questions;
    renderQuestions();
  }

  // ---------- weight filter ----------
  // Trivia questions don't score by weight, so an active filter leaves them
  // out; a missing weight counts as the default.

  function weightFilters() {
    return [
      { id: "all", label: "Tümü" },
      { id: "default", label: `Ağırlık ${DEFAULT_MATCH_WEIGHT}` },
      { id: "custom", label: `${DEFAULT_MATCH_WEIGHT} dışı (büyükten küçüğe)` },
    ];
  }

  function effectiveWeight(q) {
    return q.match_weight ?? DEFAULT_MATCH_WEIGHT;
  }

  function weightFilterActive() {
    return state.weightFilter !== "all" && isMatchCategory(state.currentCategory);
  }

  function renderWeightFilter() {
    const wrap = $("weight-filter");
    wrap.classList.toggle("hidden", !isMatchCategory(state.currentCategory));
    wrap.replaceChildren(
      ...weightFilters().map((filter) =>
        el(
          "button",
          {
            class: `chip${filter.id === state.weightFilter ? " active" : ""}`,
            onclick: () => {
              state.weightFilter = filter.id;
              renderWeightFilter();
              renderQuestions();
            },
          },
          filter.label,
        ),
      ),
    );
  }

  function applyWeightFilter(questions) {
    if (!weightFilterActive()) return questions;
    const scored = questions.filter((q) => q.correct_answer == null);
    if (state.weightFilter === "default") return scored.filter((q) => effectiveWeight(q) === DEFAULT_MATCH_WEIGHT);
    return scored
      .filter((q) => effectiveWeight(q) !== DEFAULT_MATCH_WEIGHT)
      .sort((a, b) => effectiveWeight(b) - effectiveWeight(a));
  }

  function renderQuestions() {
    const list = $("question-list");
    const term = $("search").value.trim().toLocaleLowerCase("tr");
    renderWeightFilter();
    const visible = applyWeightFilter(state.questions).filter((q) => {
      if (!term) return true;
      const haystack = [
        ...Object.values(q.texts || {}),
        ...Object.values(q.answers || {}).flat(),
      ]
        .join(" ")
        .toLocaleLowerCase("tr");
      return haystack.includes(term);
    });

    if (!visible.length) {
      const filtered = term || weightFilterActive();
      list.replaceChildren(el("div", { class: "empty", text: filtered ? "Eşleşen soru yok" : "Bu kategoride soru yok" }));
      return;
    }
    if (state.reversed) visible.reverse();
    list.replaceChildren(...visible.map(renderQuestionCard));
  }

  function renderSortButton() {
    $("btn-sort").textContent = state.reversed ? "↑ Eskiden yeniye" : "↓ Yeniden eskiye";
  }

  $("btn-sort").addEventListener("click", () => {
    state.reversed = !state.reversed;
    renderSortButton();
    renderQuestions();
  });
  renderSortButton();

  function renderQuestionCard(q) {
    const lines = LANGS.map((lang) =>
      el("div", { class: `q-line ${lang}` }, [
        el("span", { class: "lang", text: lang.toUpperCase() }),
        q.texts?.[`text_${lang}`] || "—",
      ]),
    );

    let answers = null;
    if (q.have_answers && q.answers) {
      const count = q.answers.answers_en?.length || 0;
      answers = el(
        "div",
        { class: "answers" },
        Array.from({ length: count }, (_, i) =>
          el("div", { class: "answer" }, [
            q.answers.answers_en?.[i] || "",
            el("span", {
              text: LANGS.slice(1)
                .map((lang) => ` · ${q.answers[`answers_${lang}`]?.[i] || ""}`)
                .join(""),
            }),
          ]),
        ),
      );
    }

    const optionCount = q.answers?.answers_en?.length || 0;
    const rankPlayable =
      q.question_type === "choice" &&
      q.have_answers &&
      optionCount >= RANK_MIN_ANSWERS &&
      optionCount <= RANK_MAX_ANSWERS;
    const kind = isRankCategory(q.category_id)
      ? rankPlayable
        ? { cls: " mc", label: `Sıralama · ${optionCount} seçenek` }
        : { cls: " warn", label: `⚠ Oyunda gösterilmez (${RANK_MIN_ANSWERS}-${RANK_MAX_ANSWERS} seçenek gerekli)` }
      : q.question_type === "text"
        ? { cls: " text", label: "Yazılı cevap" }
        : q.have_answers
          ? { cls: " mc", label: "Çoktan seçmeli" }
          : { cls: "", label: "Yes / No" };

    const correct =
      q.correct_answer == null
        ? null
        : el("span", {
            class: "badge trivia",
            text: `✓ ${correctAnswerText(q.correct_answer).split("\n")[0] || "?"}`,
          });

    const weight = isMatchCategory(q.category_id) && q.correct_answer == null ? renderWeightEditor(q) : null;

    return el("div", { class: "card" }, [
      el("div", { class: "q-meta" }, [
        el("span", { text: `#${q.order_index ?? "—"}` }),
        el("span", { class: `badge${kind.cls}`, text: kind.label }),
        correct,
        weight,
      ]),
      ...lines,
      answers,
      el("div", { class: "q-actions" }, [
        el("button", { class: "btn small", text: "Düzenle", onclick: () => startEdit(q) }),
        el("button", { class: "btn small danger", text: "Sil", onclick: (e) => removeQuestion(q, e.currentTarget) }),
      ]),
    ]);
  }

  // Empty input = default weight (stored as null).
  function renderWeightEditor(q) {
    const input = el("input", {
      type: "number",
      inputmode: "numeric",
      min: "1",
      max: "10",
      step: "1",
      placeholder: String(DEFAULT_MATCH_WEIGHT),
      class: "weight-input",
    });
    input.value = q.match_weight == null ? "" : String(q.match_weight);

    const button = el("button", { type: "button", class: "btn small", text: "Güncelle" });
    const save = withBusy(button, async () => {
      const raw = input.value.trim();
      const next = raw === "" ? null : Number(raw);
      if (next != null && (!Number.isInteger(next) || next < 1 || next > 10)) {
        throw new Error("Ağırlık 1 ile 10 arasında tam sayı olmalı");
      }
      if (next === (q.match_weight ?? null)) return;
      const { question } = await api(`questions/${q.id}`, {
        method: "PUT",
        body: {
          category_id: q.category_id,
          texts: q.texts,
          question_type: q.question_type,
          have_answers: q.have_answers,
          answers: q.answers,
          correct_answer: q.correct_answer,
          match_weight: next,
        },
      });
      Object.assign(q, question);
      toast(`Ağırlık güncellendi: ${question.match_weight ?? `varsayılan (${DEFAULT_MATCH_WEIGHT})`}`);
      renderQuestions();
    });
    button.addEventListener("click", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
    });

    return el("span", { class: "weight-edit" }, [el("span", { text: "⚖️" }), input, button]);
  }

  $("search").addEventListener("input", renderQuestions);

  async function removeQuestion(q, button) {
    if (!confirm(`Silinsin mi?\n\n${q.texts?.text_en || q.id}`)) return;
    await withBusy(button, async () => {
      await api(`questions/${q.id}`, { method: "DELETE" });
      toast("Soru silindi");
      await Promise.all([loadQuestions(), loadCategories()]);
    })();
  }

  // ---------- form ----------

  // Pasted text is read line by line in the fixed LANGS order (EN, TR, ES, PT).
  // Blank lines are ignored so the input can be spaced out freely.
  const LANG_META = {
    en: { flag: "🇬🇧", code: "EN" },
    tr: { flag: "🇹🇷", code: "TR" },
    es: { flag: "🇪🇸", code: "ES" },
    pt: { flag: "🇧🇷", code: "PT" },
  };
  // "🇬🇧 EN → 🇹🇷 TR → ..." for form labels.
  const LANG_ORDER = LANGS.map((lang) => `${LANG_META[lang].flag} ${LANG_META[lang].code}`).join(" → ");
  const MIN_ANSWERS = 2;
  // Rank It questions are always multiple choice with this many options; the
  // game skips the others.
  const RANK_GROUP = "rank_it";
  const RANK_MIN_ANSWERS = 3;
  const RANK_MAX_ANSWERS = 5;

  function isRankCategory(categoryId) {
    return state.categories.find((c) => c.id === categoryId)?.group_id === RANK_GROUP;
  }

  // Decorations AI output tends to add: "1.", "-", flag emojis, "EN:",
  // "Türkçe -" and wrapping quotes. The preview shows the cleaned value, which
  // is exactly what gets saved.
  const LIST_MARKER = /^(?:\d{1,2}[.)]|[-*•])\s+/;
  const FLAGS = /^(?:\p{Regional_Indicator}{2}\s*)+/u;
  const LANG_LABEL =
    /^(?:en|eng|english|ingilizce|İngilizce|tr|turkish|türkçe|turkce|es|spanish|español|espanol|ispanyolca|İspanyolca|pt|pt-br|portuguese|português|portugues|portekizce)\s*[:\-–—]\s+/iu;
  const WRAPPING_QUOTES = /^["“«]([^"“”«»]*)["”»]$/;

  function cleanLine(raw) {
    let value = raw.trim().replace(LIST_MARKER, "").replace(FLAGS, "").replace(LANG_LABEL, "").trim();
    const quoted = value.match(WRAPPING_QUOTES);
    if (quoted) value = quoted[1].trim();
    return value;
  }

  function parseLines(text) {
    return text
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);
  }

  function parseTexts(text) {
    const lines = parseLines(text);
    const values = Object.fromEntries(LANGS.map((lang, i) => [lang, lines[i] || ""]));
    const extra = lines.slice(LANGS.length);
    let error = null;
    if (!lines.length) error = "Soru metni boş";
    else if (lines.length < LANGS.length) error = `${lines.length} satır bulundu, ${LANGS.length} gerekli`;
    else if (extra.length) error = `${lines.length} satır bulundu, sadece ${LANGS.length} olmalı`;
    return { values, extra, error };
  }

  function parseAnswers(text) {
    const lines = parseLines(text);
    const groups = [];
    for (let i = 0; i < lines.length; i += LANGS.length) {
      groups.push(Object.fromEntries(LANGS.map((lang, j) => [lang, lines[i + j] || ""])));
    }
    let error = null;
    const remainder = lines.length % LANGS.length;
    if (!lines.length) error = "Cevap yok";
    else if (remainder) error = `${lines.length} satır bulundu, ${LANGS.length}'ün katı olmalı (son cevap eksik)`;
    else if (groups.length < MIN_ANSWERS) error = `En az ${MIN_ANSWERS} cevap gerekli`;
    else if (
      isRankCategory($("f-category").value) &&
      (groups.length < RANK_MIN_ANSWERS || groups.length > RANK_MAX_ANSWERS)
    ) {
      error = `Sırala Bakalım için ${RANK_MIN_ANSWERS}-${RANK_MAX_ANSWERS} seçenek gerekli (${groups.length} var)`;
    }
    return { groups, error };
  }

  function previewRow(lang, value) {
    const meta = LANG_META[lang];
    return el("div", { class: `preview-row${value ? "" : " missing"}` }, [
      el("span", { class: "lang", text: `${meta.flag} ${meta.code}` }),
      el("span", { class: "value", text: value || "eksik" }),
    ]);
  }

  function previewStatus(error, okText) {
    return el("div", { class: `preview-status ${error ? "err" : "ok"}`, text: error ? `✕ ${error}` : `✓ ${okText}` });
  }

  function renderTextsPreview() {
    const box = $("texts-preview");
    const raw = $("f-texts").value;
    if (!raw.trim()) return box.replaceChildren();
    const { values, extra, error } = parseTexts(raw);
    box.replaceChildren(
      previewStatus(error, "3 dil algılandı"),
      el("div", { class: "preview-group" }, [
        ...LANGS.map((lang) => previewRow(lang, values[lang])),
        ...extra.map((line) =>
          el("div", { class: "preview-row extra" }, [
            el("span", { class: "lang", text: "fazla" }),
            el("span", { class: "value", text: line }),
          ]),
        ),
      ]),
    );
  }

  function renderAnswersPreview() {
    const box = $("answers-preview");
    const raw = $("f-answers").value;
    if (!raw.trim()) return box.replaceChildren();
    const { groups, error } = parseAnswers(raw);
    box.replaceChildren(
      previewStatus(error, `${groups.length} cevap algılandı`),
      ...groups.map((group, i) =>
        el("div", { class: "preview-group" }, [
          el("div", { class: "preview-group-title", text: `Cevap ${i + 1}` }),
          ...LANGS.map((lang) => previewRow(lang, group[lang])),
        ]),
      ),
    );
  }

  $("f-texts").addEventListener("input", renderTextsPreview);
  $("f-answers").addEventListener("input", renderAnswersPreview);

  function setHaveAnswers(on) {
    const isText = $("f-text-question").checked;
    $("f-have-answers").checked = on && !isText;
    $("answers-box").classList.toggle("hidden", !on || isText);
    renderCorrectBox();
  }

  // Text questions are typed freely, so the answer list is hidden while on.
  function setTextQuestion(on) {
    $("f-text-question").checked = on;
    $("have-answers-row").classList.toggle("hidden", on);
    setHaveAnswers($("f-have-answers").checked);
  }

  $("f-have-answers").addEventListener("change", (e) => setHaveAnswers(e.target.checked));
  $("f-text-question").addEventListener("change", (e) => setTextQuestion(e.target.checked));

  // A checked "Sabit" box next to a toggle keeps that toggle as-is after
  // adding a question, so a batch of the same type doesn't need re-toggling.
  function isPinned(id) {
    return Boolean(document.querySelector(`[data-pin="${id}"]`)?.checked);
  }

  function pinnedValue(id, current) {
    return isPinned(id) ? current : false;
  }

  // ---------- trivia correct answer ----------
  // Yes/no and multiple choice pick from a list; typed answers take one line
  // per language (EN, TR, ES, PT), with alternatives separated by "|".

  const ALT_SEPARATOR = "|";

  function correctMode() {
    if ($("f-text-question").checked) return "text";
    return $("f-have-answers").checked ? "choice" : "yes_no";
  }

  function renderCorrectBox() {
    const on = $("f-trivia").checked;
    $("correct-box").classList.toggle("hidden", !on);
    if (!on) return;

    const mode = correctMode();
    const select = $("f-correct-choice");
    const textarea = $("f-correct");
    select.classList.toggle("hidden", mode === "text");
    textarea.classList.toggle("hidden", mode !== "text");
    $("f-correct-label").textContent =
      mode === "text"
        ? `Kabul edilen cevaplar · ${LANGS.length} satır: ${LANG_ORDER} · alternatifleri "${ALT_SEPARATOR}" ile ayır`
        : "Doğru cevap";
    if (mode === "text") return;

    const options =
      mode === "yes_no"
        ? [
            { value: "yes", label: "Yes / Evet" },
            { value: "no", label: "No / Hayır" },
          ]
        : parseAnswers($("f-answers").value).groups
            .filter((g) => g.en)
            .map((g) => ({ value: g.en, label: LANGS.map((lang) => g[lang]).join(" · ") }));
    const wanted = state.pendingCorrect ?? select.value;
    select.replaceChildren(
      el("option", { value: "", text: "— seç —" }),
      ...options.map((o) => el("option", { value: o.value, text: o.label })),
    );
    if (options.some((o) => o.value === wanted)) select.value = wanted;
    state.pendingCorrect = undefined;
  }

  function isTriviaCategory(categoryId) {
    return Boolean(state.categories.find((c) => c.id === categoryId)?.is_trivia);
  }

  // Trivia categories can't take a question without a correct answer, so the
  // switch stays on (and locked) there. Rank It categories lock the form to
  // multiple choice with 3-5 options and no correct answer.
  function setTrivia(on) {
    const category = $("f-category").value;
    const rank = isRankCategory(category);
    const locked = isTriviaCategory(category);
    if (rank) {
      setTextQuestion(false);
      setHaveAnswers(true);
    }
    $("f-text-question").disabled = rank;
    $("f-have-answers").disabled = rank;
    $("text-question-row").classList.toggle("hidden", rank);
    $("have-answers-row").classList.toggle("hidden", rank || $("f-text-question").checked);
    $("trivia-row").classList.toggle("hidden", rank);
    $("rank-note").classList.toggle("hidden", !rank);
    $("f-answers-label").textContent = rank
      ? `Seçenekler · 3-5 tane · her biri ${LANGS.length} satır: ${LANG_ORDER}`
      : `Cevaplar · her cevap için ${LANGS.length} satır: ${LANG_ORDER}`;
    $("f-trivia").checked = !rank && (on || locked);
    $("f-trivia").disabled = rank || locked;
    renderAnswersPreview();
    renderCorrectBox();
    renderWeightBox();
  }

  $("f-category").addEventListener("change", () => {
    const wasLocked = $("f-trivia").disabled;
    setTrivia(wasLocked ? false : $("f-trivia").checked);
  });

  // ---------- match weight ----------
  // Only "see your match" categories score by weight; a category's group is
  // its game mode, and anything but these plays as see your match.

  const DEFAULT_MATCH_WEIGHT = 5;
  const NON_MATCH_GROUPS = ["know_each_other", "who_knows_better", "who_is_more_likely", "rank_it"];

  function isMatchCategory(categoryId) {
    const category = state.categories.find((c) => c.id === categoryId);
    return !category || !NON_MATCH_GROUPS.includes(category.group_id);
  }

  $("f-weight").replaceChildren(
    el("option", { value: "", text: `Varsayılan (${DEFAULT_MATCH_WEIGHT})` }),
    ...Array.from({ length: 10 }, (_, i) => el("option", { value: String(i + 1), text: String(i + 1) })),
  );

  function weightApplies() {
    return isMatchCategory($("f-category").value) && !$("f-trivia").checked;
  }

  function renderWeightBox() {
    $("weight-box").classList.toggle("hidden", !weightApplies());
  }

  $("f-category").addEventListener("change", renderWeightBox);

  $("f-trivia").addEventListener("change", (e) => setTrivia(e.target.checked));
  $("f-answers").addEventListener("input", renderCorrectBox);

  function correctAnswerText(raw) {
    if (raw == null) return "";
    const lists =
      Array.isArray(raw) || typeof raw === "string"
        ? Object.fromEntries(LANGS.map((lang) => [lang, raw]))
        : raw;
    return LANGS.map((lang) => [].concat(lists[lang] ?? []).join(` ${ALT_SEPARATOR} `)).join("\n");
  }

  function readCorrectAnswer() {
    if (!$("f-trivia").checked) return null;
    const mode = correctMode();
    if (mode !== "text") {
      const value = $("f-correct-choice").value;
      if (!value) throw new Error("Doğru cevap seçilmedi");
      return value;
    }
    const lines = $("f-correct").value.split(/\r?\n/).map(cleanLine);
    const lists = Object.fromEntries(
      LANGS.map((lang, i) => [
        lang,
        (lines[i] || "")
          .split(ALT_SEPARATOR)
          .map((v) => v.trim())
          .filter(Boolean),
      ]),
    );
    if (!LANGS.some((lang) => lists[lang].length)) throw new Error("Doğru cevap boş");
    return lists;
  }

  function resetForm({ keepCategory = true } = {}) {
    const saved = state.pinnedToggles;
    const keepText = pinnedValue("f-text-question", saved?.text ?? $("f-text-question").checked);
    const keepHaveAnswers = pinnedValue(
      "f-have-answers",
      saved?.haveAnswers ?? $("f-have-answers").checked,
    );
    const keepTrivia = pinnedValue("f-trivia", saved?.trivia ?? $("f-trivia").checked);

    state.editingId = null;
    state.pinnedToggles = null;
    $("form-title").textContent = "Yeni soru";
    $("btn-submit").textContent = "Ekle";
    $("btn-cancel-edit").classList.add("hidden");
    $("f-texts").value = "";
    $("f-answers").value = "";
    $("f-correct").value = "";
    $("f-weight").value = "";
    renderTextsPreview();
    renderAnswersPreview();
    setTextQuestion(keepText);
    setHaveAnswers(keepHaveAnswers);
    if (!keepCategory) $("f-category").value = state.currentCategory || "";
    setTrivia(keepTrivia);
  }

  function startEdit(q) {
    state.pinnedToggles = {
      text: $("f-text-question").checked,
      haveAnswers: $("f-have-answers").checked,
      trivia: $("f-trivia").checked,
    };
    state.editingId = q.id;
    $("form-title").textContent = "Soruyu düzenle";
    $("btn-submit").textContent = "Kaydet";
    $("btn-cancel-edit").classList.remove("hidden");
    $("f-category").value = q.category_id;
    renderStats();
    $("f-texts").value = LANGS.map((lang) => q.texts?.[`text_${lang}`] || "").join("\n");

    let answersText = "";
    if (q.have_answers && q.answers) {
      const count = q.answers.answers_en?.length || 0;
      answersText = Array.from({ length: count }, (_, i) =>
        LANGS.map((lang) => q.answers[`answers_${lang}`]?.[i] || "").join("\n"),
      ).join("\n\n");
    }
    $("f-answers").value = answersText;

    renderTextsPreview();
    renderAnswersPreview();
    setTextQuestion(q.question_type === "text");
    setHaveAnswers(Boolean(q.have_answers));
    const isTextKey = q.question_type === "text";
    $("f-correct").value = isTextKey ? correctAnswerText(q.correct_answer) : "";
    state.pendingCorrect = !isTextKey && typeof q.correct_answer === "string" ? q.correct_answer : undefined;
    $("f-weight").value = q.match_weight == null ? "" : String(q.match_weight);
    setTrivia(q.correct_answer != null);
    switchTab("form");
  }

  $("btn-cancel-edit").addEventListener("click", () => {
    resetForm();
    switchTab("list");
  });

  $("btn-clear-form").addEventListener("click", () => {
    resetForm({ keepCategory: true });
    $("f-texts").focus();
  });

  function collectForm() {
    const texts = parseTexts($("f-texts").value);
    if (texts.error) throw new Error(`Soru: ${texts.error}`);

    const isText = $("f-text-question").checked;
    const payload = {
      category_id: $("f-category").value,
      texts: Object.fromEntries(LANGS.map((lang) => [`text_${lang}`, texts.values[lang]])),
      question_type: isText ? "text" : "choice",
      have_answers: !isText && $("f-have-answers").checked,
      answers: null,
    };

    if (payload.have_answers) {
      const answers = parseAnswers($("f-answers").value);
      if (answers.error) throw new Error(`Cevaplar: ${answers.error}`);
      payload.answers = Object.fromEntries(
        LANGS.map((lang) => [`answers_${lang}`, answers.groups.map((group) => group[lang])]),
      );
    }
    payload.correct_answer = readCorrectAnswer();
    const weight = $("f-weight").value;
    payload.match_weight = weightApplies() && weight ? Number(weight) : null;
    return payload;
  }

  $("question-form").addEventListener("submit", (e) => {
    e.preventDefault();
    withBusy($("btn-submit"), async () => {
      const payload = collectForm();
      if (state.editingId) {
        await api(`questions/${state.editingId}`, { method: "PUT", body: payload });
        toast("Soru güncellendi");
        resetForm();
        state.currentCategory = payload.category_id;
        switchTab("list");
      } else {
        await api("questions", { method: "POST", body: payload });
        const added = readCounter() + 1;
        writeCounter(added);
        toast(`Soru eklendi ✓ (sayaç: ${added})`);
        resetForm();
        $("f-category").value = payload.category_id;
        renderWeightBox();
        $("f-texts").focus();
        state.currentCategory = payload.category_id;
      }
      await loadCategories();
      await loadQuestions();
    })();
  });

  // ---------- SQL ----------

  const SQL_TEMPLATE = `INSERT INTO questions (id, category_id, texts, question_type, have_answers, answers, correct_answer, match_weight, order_index, created_at, updated_at)
VALUES (
  gen_random_uuid(),
  'spicy',
  '{"text_en": "...", "text_tr": "...", "text_es": "...", "text_pt": "..."}'::jsonb,
  'choice', -- 'text' = yazılı cevap (have_answers false, answers NULL olmalı)
  false,
  NULL,
  NULL, -- bilgi yarışması: '"yes"' / '"Canberra"' (answers_en'deki hali) / '{"en":["Mars"],"tr":["Mars"],"es":["Marte"],"pt":["Marte"]}'
  NULL, -- eşleşme ağırlığı 1-10 (sadece match kategorileri, NULL = 5)
  (SELECT COALESCE(MAX(order_index), 0) + 1 FROM questions WHERE category_id = 'spicy'),
  now(),
  now()
)
RETURNING id, category_id, texts;`;

  $("btn-sql-template").addEventListener("click", () => {
    const input = $("sql-input");
    if (input.value.trim() && !confirm("Mevcut query'nin üzerine yazılsın mı?")) return;
    input.value = SQL_TEMPLATE;
  });
  $("btn-sql-clear").addEventListener("click", () => {
    $("sql-input").value = "";
    $("sql-results").replaceChildren();
  });

  function formatCell(value) {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function renderSqlResult(data) {
    const nodes = [
      el("div", {
        class: `banner ${data.committed ? "ok" : "warn"}`,
        text: data.committed
          ? `✓ COMMIT edildi (${data.durationMs} ms)`
          : `Önizleme – ROLLBACK edildi, hiçbir şey kaydedilmedi (${data.durationMs} ms)`,
      }),
    ];
    data.results.forEach((r, i) => {
      const head = el("div", {
        class: "result-head",
        text: `#${i + 1} ${r.command || "?"} · ${r.rowCount ?? 0} satır${r.truncated ? " (ilk 200 gösteriliyor)" : ""}`,
      });
      let table = null;
      if (r.fields.length) {
        table = el("div", { class: "table-wrap" }, [
          el("table", {}, [
            el("thead", {}, el("tr", {}, r.fields.map((f) => el("th", { text: f })))),
            el(
              "tbody",
              {},
              r.rows.map((row) => el("tr", {}, r.fields.map((f) => el("td", { text: formatCell(row[f]) })))),
            ),
          ]),
        ]);
      }
      nodes.push(el("div", { class: "result" }, [head, table]));
    });
    $("sql-results").replaceChildren(...nodes);
  }

  function renderSqlError(err) {
    const details = err.body?.details;
    const extra = details
      ? Object.entries(details)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "";
    $("sql-results").replaceChildren(
      el("div", { class: "banner err", text: `${err.message}${extra ? `\n${extra}` : ""}` }),
    );
  }

  async function runSql(mode) {
    const sql = $("sql-input").value;
    if (!sql.trim()) throw new Error("Query boş");
    try {
      renderSqlResult(await api("sql", { method: "POST", body: { sql, mode } }));
    } catch (err) {
      if (err instanceof ApiError) renderSqlError(err);
      throw err;
    }
  }

  $("btn-sql-preview").addEventListener("click", withBusy($("btn-sql-preview"), () => runSql("preview")));

  $("btn-sql-apply").addEventListener(
    "click",
    withBusy($("btn-sql-apply"), async () => {
      const target = state.localBypass ? "LOKAL (.env DATABASE_URL)" : "PROD";
      if (!confirm(`Bu query ${target} veritabanında COMMIT edilecek. Emin misin?`)) return;
      if (!state.localBypass) await passkeyAssertion("step-up");
      await runSql("apply");
      toast("SQL uygulandı");
      await loadCategories().catch(() => {});
      if (state.currentCategory) await loadQuestions().catch(() => {});
    }),
  );

  // ---------- push notifications ----------
  // Each language with a title and body goes to that language's users only;
  // a language left empty is skipped. Limits match the backend's.

  const PUSH_MAX_TITLE = 120;
  const PUSH_MAX_BODY = 600;
  const PUSH_TYPE_LABELS = {
    general: "Genel duyuru",
    new_questions: "Yeni sorular",
    new_category: "Yeni kategori",
  };

  $("p-texts").replaceChildren(
    ...LANGS.map((lang) => {
      const meta = LANG_META[lang];
      return el("div", { class: "push-lang" }, [
        el("div", { class: "push-lang-head" }, [
          el("span", { text: `${meta.flag} ${meta.code}` }),
          el("span", { id: `p-count-${lang}`, class: "muted" }),
        ]),
        el("input", {
          id: `p-title-${lang}`,
          type: "text",
          placeholder: "Başlık",
          maxlength: String(PUSH_MAX_TITLE),
          autocomplete: "off",
        }),
        el("textarea", {
          id: `p-body-${lang}`,
          rows: "3",
          placeholder: "Mesaj",
          maxlength: String(PUSH_MAX_BODY),
        }),
      ]);
    }),
  );

  function renderPushCategories() {
    const select = $("p-category");
    const previous = select.value;
    select.replaceChildren(
      el("option", { value: "", text: "— kategori yok —" }),
      ...state.categories.map((category) =>
        el("option", { value: category.id, text: `${categoryLabel(category)} (${category.id})` }),
      ),
    );
    select.value = previous;
  }

  function renderPushType() {
    const type = $("p-type").value;
    $("p-category-box").classList.toggle("hidden", type === "general");
    $("p-category-label").textContent =
      type === "new_category" ? "Kategori (zorunlu)" : "Kategori (opsiyonel · seçili açılır)";
    renderPushPreview();
  }

  async function loadPushAudience() {
    const { byLanguage, usersByLanguage } = await api("notifications/audience");
    state.pushAudience = byLanguage;
    state.pushUsers = usersByLanguage || null;
    const total = LANGS.reduce((sum, lang) => sum + (byLanguage[lang] || 0), 0);
    $("push-audience").replaceChildren(
      ...LANGS.map((lang) =>
        el("div", { class: "stat-cat" }, [
          el("span", { class: "name", text: `${LANG_META[lang].flag} ${LANG_META[lang].code}` }),
          el("span", { class: "num", text: byLanguage[lang] ?? 0 }),
        ]),
      ),
      el("div", { class: "stat-cat active" }, [
        el("span", { class: "name", text: "Toplam" }),
        el("span", { class: "num", text: total }),
      ]),
    );
    renderPushPreview();
  }

  function readPushTexts() {
    return Object.fromEntries(
      LANGS.map((lang) => [
        lang,
        { title: $(`p-title-${lang}`).value.trim(), body: $(`p-body-${lang}`).value.trim() },
      ]),
    );
  }

  function renderPushPreview() {
    const texts = readPushTexts();
    const audience = state.pushAudience;
    for (const lang of LANGS) {
      const { title, body } = texts[lang];
      const count = audience ? `${audience[lang] ?? 0} cihaz` : "";
      const status = !title && !body ? "gönderilmeyecek" : !title || !body ? "başlık ve mesaj gerekli" : "";
      $(`p-count-${lang}`).textContent = [count, status].filter(Boolean).join(" · ");
    }

    const filled = LANGS.filter((lang) => texts[lang].title && texts[lang].body);
    const skipped = LANGS.filter((lang) => !filled.includes(lang));
    const box = $("push-preview");
    if (!filled.length) return box.replaceChildren();

    const reach = audience ? filled.reduce((sum, lang) => sum + (audience[lang] || 0), 0) : null;
    const lines = [
      `${PUSH_TYPE_LABELS[$("p-type").value]} → ${filled.map((l) => LANG_META[l].code).join(", ")}${reach == null ? "" : ` · ${reach} cihaz`}`,
    ];
    if (skipped.length) {
      lines.push(`${skipped.map((l) => LANG_META[l].code).join(", ")} kullanıcılarına gitmeyecek`);
    }
    const coins = readPushCoins();
    if (Number.isNaN(coins)) {
      lines.push(`🪙 Coin geçersiz (0-${PUSH_MAX_COINS} arası tam sayı)`);
    } else if (coins) {
      const users = state.pushUsers
        ? filled.reduce((sum, lang) => sum + (state.pushUsers[lang] || 0), 0)
        : null;
      lines.push(
        `🪙 Bildirim ulaşan her kullanıcıya ${coins} coin${users == null ? "" : ` · en fazla ~${users} kullanıcı, ~${users * coins} coin`}`,
      );
    }
    box.replaceChildren(
      el("div", { class: `banner ${skipped.length ? "warn" : "ok"}`, text: lines.join("\n") }),
    );
  }

  const PUSH_MAX_COINS = 1000;

  // Throws on anything but empty or a whole number in range, so a typo can't
  // silently send no coins (or the wrong amount).
  function readPushCoins() {
    const raw = $("p-coins").value.trim();
    if (!raw) return 0;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 && value <= PUSH_MAX_COINS ? value : NaN;
  }

  function validPushCoins() {
    const coins = readPushCoins();
    if (Number.isNaN(coins)) throw new Error(`Coin 0 ile ${PUSH_MAX_COINS} arasında tam sayı olmalı`);
    return coins;
  }

  $("p-type").addEventListener("change", renderPushType);
  $("p-texts").addEventListener("input", renderPushPreview);
  $("p-coins").addEventListener("input", renderPushPreview);
  renderPushType();

  function collectPush(appUserId) {
    const texts = readPushTexts();
    for (const lang of LANGS) {
      const { title, body } = texts[lang];
      if (Boolean(title) !== Boolean(body)) {
        throw new Error(`${LANG_META[lang].code}: başlık ve mesajın ikisi de dolu olmalı`);
      }
    }
    if (!LANGS.some((lang) => texts[lang].title)) throw new Error("En az bir dil doldurulmalı");

    const type = $("p-type").value;
    const categoryId = type === "general" ? "" : $("p-category").value;
    if (type === "new_category" && !categoryId) throw new Error("Kategori seçilmedi");
    const coins = validPushCoins();

    return {
      type,
      texts,
      ...(coins ? { coins } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(appUserId ? { appUserId } : {}),
    };
  }

  function coinRewardLine(reward) {
    if (!reward) return "";
    const base = `🪙 ${reward.creditedUsers} kullanıcıya ${reward.amount} coin eklendi`;
    return reward.failedUsers
      ? `${base} · ${reward.failedUsers} kullanıcıya EKLENEMEDİ: ${reward.error || "bilinmeyen hata"}`
      : base;
  }

  function renderPushResult(summary, target, coinReward) {
    const perLanguage = LANGS.filter((lang) => summary.byLanguage?.[lang])
      .map((lang) => {
        const s = summary.byLanguage[lang];
        return `${LANG_META[lang].code}: ${s.totalSuccess}/${s.totalTokens}`;
      })
      .join(" · ");
    const lines = [
      `✓ ${target}: ${summary.totalSuccess} başarılı, ${summary.totalFailure} başarısız (${summary.totalTokens} cihaz)`,
      perLanguage,
      summary.invalidatedTokenCount ? `${summary.invalidatedTokenCount} geçersiz token pasif yapıldı` : "",
      summary.totalTokens === 0 ? "Hiç cihaz bulunamadı (dil veya appUserId eşleşmedi)" : "",
      coinRewardLine(coinReward),
    ].filter(Boolean);
    const warn = summary.totalFailure || !summary.totalTokens || coinReward?.failedUsers;
    $("push-results").replaceChildren(
      el("div", { class: `banner ${warn ? "warn" : "ok"}`, text: lines.join("\n") }),
    );
  }

  async function sendPush(body, target) {
    try {
      const { summary, coinReward } = await api("notifications/send", { method: "POST", body });
      renderPushResult(summary, target, coinReward);
      return summary;
    } catch (err) {
      $("push-results").replaceChildren(el("div", { class: "banner err", text: err.message }));
      throw err;
    }
  }

  $("btn-push-refresh").addEventListener(
    "click",
    withBusy($("btn-push-refresh"), loadPushAudience),
  );

  $("btn-push-test").addEventListener(
    "click",
    withBusy($("btn-push-test"), async () => {
      const appUserId = $("p-app-user").value.trim();
      if (!appUserId) throw new Error("Test için appUserId gir");
      await sendPush(collectPush(appUserId), "Test");
      toast("Test bildirimi gönderildi");
    }),
  );

  $("btn-push-send").addEventListener(
    "click",
    withBusy($("btn-push-send"), async () => {
      const body = collectPush(null);
      const audience = state.pushAudience;
      const filled = LANGS.filter((lang) => body.texts[lang].title);
      const reach = audience ? filled.reduce((sum, lang) => sum + (audience[lang] || 0), 0) : "?";
      const target = state.localBypass ? ".env DATABASE_URL veritabanındaki" : "PROD";
      const summaryText = filled
        .map((lang) => `${LANG_META[lang].code}: ${body.texts[lang].title}`)
        .join("\n");
      const coinText = body.coins
        ? `\n\n🪙 Bildirim ulaşan HER kullanıcıya ${body.coins} coin eklenecek.`
        : "";
      const typed = prompt(
        `${target} kullanıcılarına ${reach} cihaza bildirim gidecek:\n\n${summaryText}${coinText}\n\nEmin misin? Göndermek için HERKESE yaz:`,
      );
      if (typed === null) return;
      if (typed.trim().toLocaleUpperCase("tr") !== "HERKESE") {
        toast("Gönderilmedi: onay metni eşleşmedi", true);
        return;
      }
      if (!state.localBypass) await passkeyAssertion("step-up");
      await sendPush({ ...body, broadcast: true }, "Gönderildi");
      toast("Bildirim gönderildi");
      loadPushAudience().catch(() => {});
    }),
  );

  // ---------- announcements ----------
  // In-app announcements (bell on the main menu). Title/message are per
  // language; the app falls back to English, then any filled language.

  const ANN_MAX_TITLE = 120;
  const ANN_MAX_MESSAGE = 2000;

  $("a-texts").replaceChildren(
    ...LANGS.map((lang) => {
      const meta = LANG_META[lang];
      return el("div", { class: "push-lang" }, [
        el("div", { class: "push-lang-head" }, [el("span", { text: `${meta.flag} ${meta.code}` })]),
        el("input", {
          id: `a-title-${lang}`,
          type: "text",
          placeholder: "Başlık",
          maxlength: String(ANN_MAX_TITLE),
          autocomplete: "off",
        }),
        el("textarea", {
          id: `a-message-${lang}`,
          rows: "3",
          placeholder: "Mesaj (opsiyonel)",
          maxlength: String(ANN_MAX_MESSAGE),
        }),
      ]);
    }),
  );

  // datetime-local works in the browser's local time; the API takes ISO (UTC).
  function toLocalInput(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function fromLocalInput(value) {
    return value ? new Date(value).toISOString() : null;
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });
  }

  function announcementStatus(a) {
    const now = Date.now();
    if (!a.is_active) return { cls: "off", label: "Pasif" };
    if (a.end_date && new Date(a.end_date).getTime() < now) return { cls: "off", label: "Süresi doldu" };
    if (a.start_date && new Date(a.start_date).getTime() > now) {
      return { cls: "scheduled", label: "Planlandı" };
    }
    return { cls: "live", label: "Yayında" };
  }

  async function loadAnnouncements() {
    const list = $("announcement-list");
    if (!state.announcements.length) {
      list.replaceChildren(el("div", { class: "empty", text: "Yükleniyor…" }));
    }
    const { announcements } = await api("announcements");
    state.announcements = announcements;
    renderAnnouncements();
  }

  function renderAnnouncements() {
    const list = $("announcement-list");
    if (!state.announcements.length) {
      list.replaceChildren(el("div", { class: "empty", text: "Henüz duyuru yok" }));
      return;
    }
    list.replaceChildren(...state.announcements.map(renderAnnouncementCard));
  }

  function renderAnnouncementCard(a) {
    const status = announcementStatus(a);
    const lines = LANGS.filter((lang) => a.title?.[lang] || a.message?.[lang]).flatMap((lang) => [
      el("div", { class: `q-line ${lang}` }, [
        el("span", { class: "lang", text: lang.toUpperCase() }),
        a.title?.[lang] || "—",
      ]),
      a.message?.[lang] ? el("div", { class: "a-message", text: a.message[lang] }) : null,
    ]);
    const missing = LANGS.filter((lang) => !a.title?.[lang]);

    const dates = [
      a.start_date ? `Başlangıç: ${formatDate(a.start_date)}` : "Başlangıç: hemen",
      a.end_date ? `Bitiş: ${formatDate(a.end_date)}` : "Bitiş: süresiz",
    ].join(" · ");

    return el("div", { class: `card a-card${a.is_active ? "" : " inactive"}` }, [
      el("div", { class: "q-meta" }, [
        el("span", { class: `badge ${status.cls}`, text: status.label }),
        el("span", { text: `Öncelik ${a.priority ?? 0}` }),
        missing.length
          ? el("span", { class: "badge warn", text: `${missing.map((l) => l.toUpperCase()).join(", ")} yok → EN gösterilir` })
          : null,
      ]),
      ...lines,
      el("div", { class: "a-dates", text: dates }),
      a.action_url ? el("div", { class: "a-link", text: `🔗 ${a.action_url}` }) : null,
      el("div", { class: "q-actions" }, [
        el("button", {
          class: "btn small",
          text: a.is_active ? "Pasif yap" : "Aktif yap",
          onclick: (e) => toggleAnnouncement(a, e.currentTarget),
        }),
        el("button", { class: "btn small", text: "Düzenle", onclick: () => startAnnouncementEdit(a) }),
        el("button", { class: "btn small danger", text: "Sil", onclick: (e) => removeAnnouncement(a, e.currentTarget) }),
      ]),
    ]);
  }

  async function toggleAnnouncement(a, button) {
    await withBusy(button, async () => {
      const { announcement } = await api(`announcements/${a.id}/active`, {
        method: "PATCH",
        body: { is_active: !a.is_active },
      });
      Object.assign(a, announcement);
      toast(announcement.is_active ? "Duyuru aktif" : "Duyuru pasif");
      renderAnnouncements();
    })();
  }

  async function removeAnnouncement(a, button) {
    const title = a.title?.tr || a.title?.en || Object.values(a.title || {})[0] || a.id;
    if (!confirm(`Duyuru silinsin mi?\n\n${title}\n\n(Geçici kaldırmak için "Pasif yap" da kullanabilirsin.)`)) return;
    await withBusy(button, async () => {
      await api(`announcements/${a.id}`, { method: "DELETE" });
      if (state.editingAnnouncementId === a.id) resetAnnouncementForm();
      toast("Duyuru silindi");
      await loadAnnouncements();
    })();
  }

  function resetAnnouncementForm() {
    state.editingAnnouncementId = null;
    $("a-form-title").textContent = "Yeni duyuru";
    $("btn-a-submit").textContent = "Ekle";
    $("btn-a-cancel").classList.add("hidden");
    for (const lang of LANGS) {
      $(`a-title-${lang}`).value = "";
      $(`a-message-${lang}`).value = "";
    }
    $("a-priority").value = "";
    $("a-start").value = "";
    $("a-end").value = "";
    $("a-url").value = "";
    $("a-active").checked = true;
  }

  function startAnnouncementEdit(a) {
    state.editingAnnouncementId = a.id;
    $("a-form-title").textContent = "Duyuruyu düzenle";
    $("btn-a-submit").textContent = "Kaydet";
    $("btn-a-cancel").classList.remove("hidden");
    for (const lang of LANGS) {
      $(`a-title-${lang}`).value = a.title?.[lang] || "";
      $(`a-message-${lang}`).value = a.message?.[lang] || "";
    }
    $("a-priority").value = a.priority ? String(a.priority) : "";
    $("a-start").value = toLocalInput(a.start_date);
    $("a-end").value = toLocalInput(a.end_date);
    $("a-url").value = a.action_url || "";
    $("a-active").checked = Boolean(a.is_active);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function collectAnnouncement() {
    const title = {};
    const message = {};
    for (const lang of LANGS) {
      const t = $(`a-title-${lang}`).value.trim();
      const m = $(`a-message-${lang}`).value.trim();
      if (m && !t) throw new Error(`${LANG_META[lang].code}: mesaj var ama başlık yok`);
      if (t) title[lang] = t;
      if (m) message[lang] = m;
    }
    if (!Object.keys(title).length) throw new Error("En az bir dilde başlık gerekli");

    const rawPriority = $("a-priority").value.trim();
    const priority = rawPriority ? Number(rawPriority) : 0;
    if (!Number.isInteger(priority)) throw new Error("Öncelik tam sayı olmalı");

    const start_date = fromLocalInput($("a-start").value);
    const end_date = fromLocalInput($("a-end").value);
    if (start_date && end_date && end_date <= start_date) {
      throw new Error("Bitiş, başlangıçtan sonra olmalı");
    }

    return {
      title,
      message,
      priority,
      start_date,
      end_date,
      action_url: $("a-url").value.trim() || null,
      is_active: $("a-active").checked,
    };
  }

  $("announcement-form").addEventListener("submit", (e) => {
    e.preventDefault();
    withBusy($("btn-a-submit"), async () => {
      const payload = collectAnnouncement();
      if (!payload.title.en && !confirm("İngilizce başlık yok; dili EN olan kullanıcılar başka bir dildeki metni görecek. Devam?")) {
        return;
      }
      if (state.editingAnnouncementId) {
        await api(`announcements/${state.editingAnnouncementId}`, { method: "PUT", body: payload });
        toast("Duyuru güncellendi");
      } else {
        await api("announcements", { method: "POST", body: payload });
        toast("Duyuru eklendi ✓");
      }
      resetAnnouncementForm();
      await loadAnnouncements();
    })();
  });

  document.querySelectorAll("[data-clear]").forEach((button) => {
    button.addEventListener("click", () => {
      $(button.dataset.clear).value = "";
    });
  });

  $("btn-a-cancel").addEventListener("click", resetAnnouncementForm);
  $("btn-a-clear").addEventListener("click", resetAnnouncementForm);
  $("btn-a-refresh").addEventListener("click", withBusy($("btn-a-refresh"), loadAnnouncements));

  // ---------- boot ----------

  async function enterApp() {
    $("view-login").classList.add("hidden");
    $("view-app").classList.remove("hidden");
    showLoginError("");
    await loadCategories();
    await loadQuestions();
  }

  function applyLocalBypassUi() {
    $("app-title").textContent = "KUB Admin · LOCAL";
    $("btn-add-device").classList.add("hidden");
    $("btn-logout").classList.add("hidden");
    $("btn-sql-apply").textContent = "Uygula";
  }

  async function boot() {
    try {
      const status = await api("auth/status");
      if (status.localBypass) {
        state.localBypass = true;
        applyLocalBypassUi();
        await enterApp();
        return;
      }
      if (!window.PublicKeyCredential) {
        showLogin({ registered: true });
        showLoginError("Bu tarayıcı passkey desteklemiyor. Safari kullan.");
        return;
      }
      if (status.loggedIn) await enterApp();
      else showLogin(status);
    } catch (err) {
      showLogin({ registered: true });
      showLoginError(err.message);
    }
  }

  boot();
})();
