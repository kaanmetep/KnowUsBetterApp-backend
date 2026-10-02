(() => {
  "use strict";

  const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser;
  const $ = (id) => document.getElementById(id);
  const LANGS = ["en", "tr", "es"];

  const state = {
    categories: [],
    currentCategory: null,
    questions: [],
    editingId: null,
    localBypass: false,
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
    for (const key of ["list", "form", "sql"]) {
      $(`tab-${key}`).classList.toggle("hidden", key !== name);
    }
    window.scrollTo({ top: 0 });
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.dataset.tab === "form" && state.editingId === null) resetForm();
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

  function renderQuestions() {
    const list = $("question-list");
    const term = $("search").value.trim().toLocaleLowerCase("tr");
    const visible = state.questions.filter((q) => {
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
      list.replaceChildren(el("div", { class: "empty", text: term ? "Eşleşen soru yok" : "Bu kategoride soru yok" }));
      return;
    }
    list.replaceChildren(...visible.map(renderQuestionCard));
  }

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
            el("span", { text: ` · ${q.answers.answers_tr?.[i] || ""} · ${q.answers.answers_es?.[i] || ""}` }),
          ]),
        ),
      );
    }

    return el("div", { class: "card" }, [
      el("div", { class: "q-meta" }, [
        el("span", { text: `#${q.order_index ?? "—"}` }),
        el("span", { class: `badge${q.have_answers ? " mc" : ""}`, text: q.have_answers ? "Çoktan seçmeli" : "Yes / No" }),
      ]),
      ...lines,
      answers,
      el("div", { class: "q-actions" }, [
        el("button", { class: "btn small", text: "Düzenle", onclick: () => startEdit(q) }),
        el("button", { class: "btn small danger", text: "Sil", onclick: (e) => removeQuestion(q, e.currentTarget) }),
      ]),
    ]);
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

  // Pasted text is read line by line in the fixed LANGS order (EN, TR, ES).
  // Blank lines are ignored so the input can be spaced out freely.
  const LANG_META = {
    en: { flag: "🇬🇧", code: "EN" },
    tr: { flag: "🇹🇷", code: "TR" },
    es: { flag: "🇪🇸", code: "ES" },
  };
  const MIN_ANSWERS = 2;

  // Decorations AI output tends to add: "1.", "-", flag emojis, "EN:",
  // "Türkçe -" and wrapping quotes. The preview shows the cleaned value, which
  // is exactly what gets saved.
  const LIST_MARKER = /^(?:\d{1,2}[.)]|[-*•])\s+/;
  const FLAGS = /^(?:\p{Regional_Indicator}{2}\s*)+/u;
  const LANG_LABEL =
    /^(?:en|eng|english|ingilizce|İngilizce|tr|turkish|türkçe|turkce|es|spanish|español|espanol|ispanyolca|İspanyolca)\s*[:\-–—]\s+/iu;
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
    $("f-have-answers").checked = on;
    $("answers-box").classList.toggle("hidden", !on);
  }

  $("f-have-answers").addEventListener("change", (e) => setHaveAnswers(e.target.checked));

  function resetForm({ keepCategory = true } = {}) {
    state.editingId = null;
    $("form-title").textContent = "Yeni soru";
    $("btn-submit").textContent = "Ekle";
    $("btn-cancel-edit").classList.add("hidden");
    $("f-texts").value = "";
    $("f-answers").value = "";
    renderTextsPreview();
    renderAnswersPreview();
    setHaveAnswers(false);
    if (!keepCategory) $("f-category").value = state.currentCategory || "";
  }

  function startEdit(q) {
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
    setHaveAnswers(Boolean(q.have_answers));
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

    const payload = {
      category_id: $("f-category").value,
      texts: Object.fromEntries(LANGS.map((lang) => [`text_${lang}`, texts.values[lang]])),
      have_answers: $("f-have-answers").checked,
      answers: null,
    };

    if (payload.have_answers) {
      const answers = parseAnswers($("f-answers").value);
      if (answers.error) throw new Error(`Cevaplar: ${answers.error}`);
      payload.answers = Object.fromEntries(
        LANGS.map((lang) => [`answers_${lang}`, answers.groups.map((group) => group[lang])]),
      );
    }
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
        $("f-texts").focus();
        state.currentCategory = payload.category_id;
      }
      await loadCategories();
      await loadQuestions();
    })();
  });

  // ---------- SQL ----------

  const SQL_TEMPLATE = `INSERT INTO questions (id, category_id, texts, have_answers, answers, order_index, created_at, updated_at)
VALUES (
  gen_random_uuid(),
  'spicy',
  '{"text_en": "...", "text_tr": "...", "text_es": "..."}'::jsonb,
  false,
  NULL,
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
