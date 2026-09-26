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
    return category.labels?.category_tr || category.labels?.category_en || category.id;
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
  }

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

  function addAnswerRow(values = {}) {
    const rows = $("answer-rows");
    const row = el("div", { class: "answer-row" }, [
      el("div", { class: "head" }, [
        el("span", { class: "answer-title" }),
        el("button", {
          type: "button",
          class: "btn small ghost",
          text: "Kaldır",
          onclick: () => {
            row.remove();
            renumberAnswers();
          },
        }),
      ]),
      ...LANGS.map((lang) =>
        el("input", {
          type: "text",
          "data-lang": lang,
          placeholder: { en: "🇬🇧 English", tr: "🇹🇷 Türkçe", es: "🇪🇸 Español" }[lang],
          value: values[lang] || "",
          autocomplete: "off",
        }),
      ),
    ]);
    rows.append(row);
    renumberAnswers();
  }

  function renumberAnswers() {
    $("answer-rows")
      .querySelectorAll(".answer-title")
      .forEach((node, i) => (node.textContent = `Cevap ${i + 1}`));
  }

  function setHaveAnswers(on) {
    $("f-have-answers").checked = on;
    $("answers-box").classList.toggle("hidden", !on);
    if (on && !$("answer-rows").children.length) {
      addAnswerRow();
      addAnswerRow();
    }
  }

  $("f-have-answers").addEventListener("change", (e) => setHaveAnswers(e.target.checked));
  $("btn-add-answer").addEventListener("click", () => addAnswerRow());

  function resetForm({ keepCategory = true } = {}) {
    state.editingId = null;
    $("form-title").textContent = "Yeni soru";
    $("btn-submit").textContent = "Ekle";
    $("btn-cancel-edit").classList.add("hidden");
    for (const lang of LANGS) $(`f-text-${lang}`).value = "";
    $("answer-rows").replaceChildren();
    setHaveAnswers(false);
    if (!keepCategory) $("f-category").value = state.currentCategory || "";
  }

  function startEdit(q) {
    state.editingId = q.id;
    $("form-title").textContent = "Soruyu düzenle";
    $("btn-submit").textContent = "Kaydet";
    $("btn-cancel-edit").classList.remove("hidden");
    $("f-category").value = q.category_id;
    for (const lang of LANGS) $(`f-text-${lang}`).value = q.texts?.[`text_${lang}`] || "";
    $("answer-rows").replaceChildren();
    if (q.have_answers && q.answers) {
      const count = q.answers.answers_en?.length || 0;
      for (let i = 0; i < count; i++) {
        addAnswerRow({
          en: q.answers.answers_en?.[i],
          tr: q.answers.answers_tr?.[i],
          es: q.answers.answers_es?.[i],
        });
      }
    }
    setHaveAnswers(Boolean(q.have_answers));
    switchTab("form");
  }

  $("btn-cancel-edit").addEventListener("click", () => {
    resetForm();
    switchTab("list");
  });

  function collectForm() {
    const payload = {
      category_id: $("f-category").value,
      texts: Object.fromEntries(LANGS.map((lang) => [`text_${lang}`, $(`f-text-${lang}`).value.trim()])),
      have_answers: $("f-have-answers").checked,
      answers: null,
    };
    for (const lang of LANGS) {
      if (!payload.texts[`text_${lang}`]) throw new Error(`${lang.toUpperCase()} soru metni boş`);
    }
    if (payload.have_answers) {
      const rows = [...$("answer-rows").querySelectorAll(".answer-row")];
      if (rows.length < 2) throw new Error("En az 2 cevap gerekli");
      payload.answers = Object.fromEntries(LANGS.map((lang) => [`answers_${lang}`, []]));
      rows.forEach((row, i) => {
        for (const lang of LANGS) {
          const value = row.querySelector(`input[data-lang="${lang}"]`).value.trim();
          if (!value) throw new Error(`Cevap ${i + 1} (${lang.toUpperCase()}) boş`);
          payload.answers[`answers_${lang}`].push(value);
        }
      });
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
        toast("Soru eklendi ✓");
        resetForm();
        $("f-category").value = payload.category_id;
        $("f-text-en").focus();
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
      if (!confirm("Bu query PROD veritabanında COMMIT edilecek. Emin misin?")) return;
      await passkeyAssertion("step-up");
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

  async function boot() {
    if (!window.PublicKeyCredential) {
      showLogin({ registered: true });
      showLoginError("Bu tarayıcı passkey desteklemiyor. Safari kullan.");
      return;
    }
    try {
      const status = await api("auth/status");
      if (status.loggedIn) await enterApp();
      else showLogin(status);
    } catch (err) {
      showLogin({ registered: true });
      showLoginError(err.message);
    }
  }

  boot();
})();
