/*
 * brain.js: the whole "second brain", running on your phone.
 *
 * - Everything you save or teach is stored ON THE PHONE (IndexedDB). No server, no cost.
 * - The AI is Google Gemini, called directly with your own free API key.
 * - "Training": what you teach is stored as question/answer pairs. Before every reply the
 *   relevant ones are given to Gemini with the instruction to trust them. No model retraining needed.
 */
const Brain = (() => {
  // ───────────────────────────── settings ─────────────────────────────
  const S = {
    get(k, d) { try { const v = localStorage.getItem("sb_" + k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("sb_" + k, v); } catch {} },
  };
  const settings = {
    get key() { return S.get("gemini_key", ""); },
    get model() { return S.get("model", "gemini-2.5-flash"); },
    get name() { return S.get("name", ""); },
    get currency() { return S.get("currency", "৳"); },
  };
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";

  // ───────────────────────────── storage (IndexedDB) ─────────────────────────────
  const STORES = ["notes", "knowledge", "facts", "reminders", "expenses"];
  let dbPromise;
  function db() {
    return (dbPromise ||= new Promise((resolve, reject) => {
      const r = indexedDB.open("second-brain", 1);
      r.onupgradeneeded = () => {
        for (const s of STORES)
          if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: "id", autoIncrement: true });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  const done = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  async function os(name, mode = "readonly") { return (await db()).transaction(name, mode).objectStore(name); }
  async function all(name) { const s = await os(name); return done(s.getAll()); }
  async function get(name, id) { const s = await os(name); return done(s.get(id)); }
  async function put(name, v) { const s = await os(name, "readwrite"); return done(s.put(v)); }
  async function del(name, id) { const s = await os(name, "readwrite"); return done(s.delete(id)); }
  async function clear(name) { const s = await os(name, "readwrite"); return done(s.clear()); }
  async function count(name) { const s = await os(name); return done(s.count()); }
  const now = () => Date.now();

  // ───────────────────────────── search ─────────────────────────────
  const STOP = new Set(("a an the is are was were be to of in on for and or what how why when which who whom me my i you your " +
    "about tell explain give from with this that it do does did can could please at by as so if not no yes").split(" "));
  const stem = (w) => (w.length > 4 && w.endsWith("es") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
  const words = (t) => (String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
  // a small BM25 ranking: good enough for a few thousand notes on a phone
  function rank(items, query, fields, k) {
    const q = [...new Set(words(query))];
    if (!q.length || !items.length) return [];
    const docs = items.map((it) => {
      const toks = words(fields.map((f) => it[f]).join(" "));
      const tf = {};
      for (const w of toks) tf[w] = (tf[w] || 0) + 1;
      return { it, tf, len: toks.length || 1 };
    });
    const avg = docs.reduce((a, d) => a + d.len, 0) / docs.length;
    const df = {};
    for (const w of q) df[w] = docs.filter((d) => d.tf[w]).length;
    return docs
      .map((d) => {
        let s = 0;
        for (const w of q) {
          const f = d.tf[w];
          if (!f) continue;
          const idf = Math.log(1 + (docs.length - df[w] + 0.5) / (df[w] + 0.5));
          s += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.len) / avg));
        }
        return { s, it: d.it };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.it);
  }

  // ───────────────────────────── notes ─────────────────────────────
  function chunk(text, size = 1200, overlap = 150) {
    text = String(text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return [];
    if (text.length <= size) return [text];
    const out = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + size, text.length);
      if (end < text.length) {
        let cut = text.lastIndexOf("\n", end);
        if (cut < start + size / 2) cut = text.lastIndexOf(". ", end);
        if (cut >= start + size / 2) end = cut + 1;
      }
      out.push(text.slice(start, end).trim());
      if (end >= text.length) break;
      start = Math.max(end - overlap, start + 1);
    }
    return out.filter(Boolean);
  }
  async function addNote(title, content) {
    const parts = chunk(content);
    for (let i = 0; i < parts.length; i++)
      await put("notes", { title: parts.length > 1 ? `${title} (part ${i + 1})` : title, content: parts[i], at: now() });
    return parts.length;
  }
  async function searchNotes(q, k = 5) { return rank(await all("notes"), q, ["title", "content"], k); }
  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  async function listNotes(q = "") {
    const items = q.trim() ? await searchNotes(q, 30) : (await all("notes")).reverse().slice(0, 60);
    return items.map((n) => ({ id: n.id, title: n.title, preview: n.content.slice(0, 160), date: day(n.at) }));
  }

  // ───────────────────────────── taught knowledge ─────────────────────────────
  const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");
  async function learn(question, answer) {
    question = String(question).trim(); answer = String(answer).trim();
    const same = (await all("knowledge")).find((k) => norm(k.question) === norm(question));
    if (same) { await put("knowledge", { ...same, answer, at: now() }); return `Updated what I know (#${same.id}).`; }
    const id = await put("knowledge", { question, answer, at: now() });
    return `Learned (#${id}).`;
  }
  async function listKnowledge(q = "") {
    const items = await all("knowledge");
    return q.trim() ? rank(items, q, ["question", "answer"], 50) : items.reverse();
  }
  async function forgetLearned(id) {
    if (!(await get("knowledge", Number(id)))) return `Nothing learned with #${id}.`;
    await del("knowledge", Number(id)); return `Forgot #${id}.`;
  }

  // ───────────────────────────── profile facts ─────────────────────────────
  async function rememberFact(fact) {
    fact = String(fact).trim();
    if ((await all("facts")).some((f) => norm(f.fact) === norm(fact))) return "I already knew that.";
    await put("facts", { fact, at: now() }); return "Remembered.";
  }
  const listFacts = () => all("facts");
  async function forgetFact(id) {
    if (!(await get("facts", Number(id)))) return `No fact #${id}.`;
    await del("facts", Number(id)); return `Forgot fact #${id}.`;
  }

  // ───────────────────────────── reminders ─────────────────────────────
  const fmt = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  async function addReminder(text, dueLocal) {
    const m = String(dueLocal).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
    if (!m) return "Error: due_local must look like 'YYYY-MM-DD HH:MM'.";
    const due = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
    const id = await put("reminders", { text, due, done: false });
    return `Reminder #${id} set for ${fmt(due)}${due < now() ? " (note: that time is already in the past)" : ""}.`;
  }
  async function listReminders(hours) {
    const lim = hours ? now() + hours * 3600e3 : Infinity;
    return (await all("reminders")).filter((r) => !r.done && r.due <= lim).sort((a, b) => a.due - b.due)
      .map((r) => ({ id: r.id, text: r.text, due: fmt(r.due) }));
  }
  async function cancelReminder(id) {
    const r = await get("reminders", Number(id));
    if (!r || r.done) return `No active reminder #${id}.`;
    await put("reminders", { ...r, done: true }); return `Reminder #${id} cancelled.`;
  }
  async function popDue() {
    const due = (await all("reminders")).filter((r) => !r.done && r.due <= now());
    for (const r of due) await put("reminders", { ...r, done: true, firedAt: now() });
    return due.map((r) => ({ id: r.id, text: r.text }));
  }

  // ───────────────────────────── expenses ─────────────────────────────
  async function logExpense(amount, category, note = "") {
    amount = Number(amount);
    if (!isFinite(amount)) return "Error: amount must be a number.";
    await put("expenses", { amount, category: String(category).toLowerCase().trim(), note, at: now() });
    return `Logged ${settings.currency}${amount} for ${category}.`;
  }
  async function expenseSummary(days = 30) {
    const since = now() - days * 864e5, by = {};
    for (const e of await all("expenses")) if (e.at >= since) by[e.category] = (by[e.category] || 0) + e.amount;
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    return { days, currency: settings.currency, total: Math.round(total * 100) / 100, by_category: by };
  }

  // ───────────────────────────── level / stats ─────────────────────────────
  async function stats() {
    const [taught, notes, facts] = await Promise.all([count("knowledge"), count("notes"), count("facts")]);
    const xp = taught * 3 + facts * 2 + notes;
    const level = 1 + Math.floor(Math.sqrt(xp / 5));
    const lo = 5 * (level - 1) ** 2, hi = 5 * level ** 2;
    return { taught, notes, facts, xp, level, progress: (xp - lo) / (hi - lo), to_next: hi - xp };
  }

  // ───────────────────────────── tools Gemini can use ─────────────────────────────
  const T = (name, description, props, required) =>
    props ? { name, description, parameters: { type: "OBJECT", properties: props, required } } : { name, description };
  const str = (description) => ({ type: "STRING", description });
  const TOOLS = [
    T("learn", "Permanently learn something the user TEACHES you or a CORRECTION to your answer, so you answer it their way from now on. Use whenever they say 'learn this', 'teach', 'remember that X is Y', 'that's wrong', 'actually...', 'no, the answer is...', or give a definition, rule, formula, local info (rooms, teachers, deadlines, procedures). One idea per call. 'question' = how it would be asked later; 'answer' = the correct information, complete enough to stand alone. Reusing the exact same question replaces the old answer. Personal facts about the user go to remember_about_me; long study material goes to save_note.",
      { question: str("How this would be asked later"), answer: str("The correct information") }, ["question", "answer"]),
    T("forget_learned", "Delete something you learned, by its # id (shown in the system prompt).", { id: { type: "INTEGER" } }, ["id"]),
    T("remember_about_me", "Store a lasting fact about the user themself: name, university, department, semester, courses, goals, schedule, preferences. One fact per call, in third person, e.g. 'Studies CSE at AIUB, final year'.", { fact: str("The fact") }, ["fact"]),
    T("forget_about_me", "Delete a stored personal fact by its id (shown in the system prompt).", { id: { type: "INTEGER" } }, ["id"]),
    T("save_note", "Save something to the user's notes (ideas, class notes, links, anything to remember).", { title: str("Short title, e.g. 'OS - deadlocks'"), content: str("The note") }, ["title", "content"]),
    T("search_notes", "Search the user's saved notes, PDFs and photo notes. ALWAYS use this before explaining, summarising or quizzing on a study topic. Use specific keywords.", { query: str("Keywords") }, ["query"]),
    T("list_recent_notes", "List titles of the most recently saved notes."),
    T("add_reminder", "Create a reminder. Convert relative times ('Friday 5pm', 'in 2 hours', 'tomorrow morning' = 09:00) into an exact local time using the current date/time in the system prompt.", { text: str("What to remind about"), due_local: str("Local time as 'YYYY-MM-DD HH:MM' (24h)") }, ["text", "due_local"]),
    T("list_reminders", "List upcoming reminders with their ids."),
    T("cancel_reminder", "Cancel a reminder by id (call list_reminders first if you don't know it).", { id: { type: "INTEGER" } }, ["id"]),
    T("log_expense", "Record money the user spent.", { amount: { type: "NUMBER" }, category: str("e.g. food, travel, books, rent, fun, other"), note: str("Optional detail") }, ["amount", "category"]),
    T("expense_summary", "Total spending by category over the last N days.", { days: { type: "INTEGER", description: "Default 30" } }, []),
  ];
  async function runTool(name, a) {
    const json = (x) => JSON.stringify(x);
    switch (name) {
      case "learn": return learn(a.question, a.answer);
      case "forget_learned": return forgetLearned(a.id);
      case "remember_about_me": return rememberFact(a.fact);
      case "forget_about_me": return forgetFact(a.id);
      case "save_note": { const n = await addNote(a.title, a.content); return `Saved note '${a.title}' (${n} part${n > 1 ? "s" : ""}).`; }
      case "search_notes": { const h = await searchNotes(a.query); return h.length ? json(h.map(({ title, content }) => ({ title, content }))) : "No matching notes found."; }
      case "list_recent_notes": { const t = (await all("notes")).reverse().slice(0, 15).map((n) => `${n.title} (${day(n.at)})`); return t.join("\n") || "No notes saved yet."; }
      case "add_reminder": return addReminder(a.text, a.due_local);
      case "list_reminders": { const r = await listReminders(); return r.length ? json(r) : "No upcoming reminders."; }
      case "cancel_reminder": return cancelReminder(a.id);
      case "log_expense": return logExpense(a.amount, a.category, a.note || "");
      case "expense_summary": return json(await expenseSummary(a.days || 30));
    }
    return `Unknown tool ${name}`;
  }

  // ───────────────────────────── prompt ─────────────────────────────
  async function taughtContext(query) {
    const items = await all("knowledge");
    const picked = new Map();
    for (const k of rank(items, query, ["question", "answer"], 8)) picked.set(k.id, k);
    for (const k of items.slice(-5)) picked.set(k.id, k);
    return [...picked.values()].map((k) => `#${k.id} Q: ${k.question}\n    A: ${k.answer}`).join("\n") || "(nothing taught yet)";
  }
  async function systemPrompt(query = "") {
    const name = settings.name || "the user";
    const facts = (await listFacts()).map((f) => `[${f.id}] ${f.fact}`).join("\n") || "(nothing yet)";
    const d = new Date();
    const when = d.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    return `You are the personal "second brain" assistant of ${name}, a university student, chatting on their phone.
Current local date/time: ${when} (${TZ}). ISO date today: ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.

What you know about ${name} (fact id in brackets). Use it naturally to personalise answers, plans and examples:
${facts}

Things ${name} has TAUGHT you (# id). This is your training: when one is relevant, answer with it and trust it over your general knowledge:
${await taughtContext(query)}

How to behave:
- When the user teaches you something or corrects you, call learn (one call per idea), then confirm in one short line what you learned. If a correction contradicts a taught item, reuse that item's exact question so it gets replaced.
- When the user tells you something about themself worth keeping, store it with remember_about_me.
- Use your tools to save notes, search notes, set reminders and track expenses whenever the message calls for it. Don't ask for confirmation for simple saves or reminders: do it and confirm briefly.
- For study questions, explanations, summaries or quizzes: search the notes first and base the answer on them. If they don't cover it, say so in one line, then answer from general knowledge.
- Quizzes: one question at a time, wait for the answer, then feedback and the next question.
- Reply in the language the user writes in (English or Bangla).
- Keep replies short and friendly: this is a phone chat. Plain text, simple dashes for lists, no markdown symbols like ** or ###.
- Never invent things the user supposedly saved.`;
  }
  const TEACH_PREFIX = "[TEACH MODE: I am training you. Store every useful piece of information in this message with the learn tool (one call per idea; personal facts about me go to remember_about_me). If it corrects your previous answer, learn the corrected version. Then reply with one or two short lines listing what you learned. Don't answer anything else.]\n\n";

  // ───────────────────────────── Gemini ─────────────────────────────
  class NeedKey extends Error { constructor() { super("Add your free Gemini key to start (Me tab, then Settings)."); this.needKey = true; } }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function genConfig() {
    const c = { temperature: 0.6, maxOutputTokens: 2048 };
    if (/^gemini-2\.5-flash/.test(settings.model)) c.thinkingConfig = { thinkingBudget: 0 }; // faster, saves free quota
    return c;
  }
  async function gemini(body, key = settings.key, model = settings.model) {
    if (!key) throw new NeedKey();
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
        });
      } catch { throw new Error("No internet connection. Check your mobile data or Wi-Fi and try again."); }
      if (res.ok) return res.json();
      let err = {};
      try { err = (await res.json()).error || {}; } catch {}
      const msg = err.message || "";
      if (res.status === 429) {
        const retry = (err.details || []).map((d) => d.retryDelay).find(Boolean);
        const secs = retry ? parseFloat(retry) : 0;
        if (attempt === 0 && secs && secs <= 30) { await sleep(secs * 1000 + 500); continue; }
        throw new Error(secs ? `I've hit Google's free limit. Try again in about ${Math.ceil(secs)} seconds.` :
          "I've used up Google's free limit for now. Try again later, or switch to gemini-2.5-flash-lite in Settings (it has a bigger free allowance).");
      }
      if (res.status === 400 && /api key/i.test(msg)) throw new Error("Your Gemini key isn't valid. Check it in Me, then Settings.");
      if (res.status === 403) throw new Error("Google refused the request: " + (msg || "check your key in Me, then Settings."));
      if (res.status === 404) throw new Error(`The model "${model}" isn't available. Pick another one in Me, then Settings.`);
      if (res.status >= 500 && attempt === 0) { await sleep(1500); continue; }
      throw new Error(`Gemini error ${res.status}: ${msg || "please try again."}`);
    }
  }
  const textOf = (content) => (content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();

  async function checkKey(key, model = "gemini-2.5-flash") {
    const r = await gemini({ contents: [{ role: "user", parts: [{ text: "Reply with the single word OK." }] }], generationConfig: { maxOutputTokens: 20 } }, key, model);
    return !!r;
  }

  // short-term chat memory (kept on the phone)
  let history = [];
  try { history = JSON.parse(S.get("history", "[]")); } catch { history = []; }
  const saveHistory = () => { history = history.slice(-12); S.set("history", JSON.stringify(history)); };
  function resetChat() { history = []; saveHistory(); }

  async function ask(userText, { teach = false } = {}) {
    const contents = [...history, { role: "user", parts: [{ text: teach ? TEACH_PREFIX + userText : userText }] }];
    const system = { parts: [{ text: await systemPrompt(userText) }] };
    let reply = "";
    for (let i = 0; i < 8; i++) {
      const r = await gemini({ systemInstruction: system, contents, tools: [{ functionDeclarations: TOOLS }], generationConfig: genConfig() });
      const cand = r.candidates?.[0];
      const content = cand?.content;
      if (!content?.parts?.length) {
        reply = cand?.finishReason === "SAFETY" ? "I can't help with that one." : "I didn't get an answer back. Please try again.";
        break;
      }
      contents.push({ role: "model", parts: content.parts }); // kept as-is so Gemini's tool calls stay valid
      const calls = content.parts.filter((p) => p.functionCall);
      if (!calls.length) { reply = textOf(content); break; }
      const responses = [];
      for (const p of calls) {
        let out;
        try { out = await runTool(p.functionCall.name, p.functionCall.args || {}); }
        catch (e) { out = "Error: " + e.message; }
        const fr = { name: p.functionCall.name, response: { result: out } };
        if (p.functionCall.id) fr.id = p.functionCall.id;
        responses.push({ functionResponse: fr });
      }
      contents.push({ role: "user", parts: responses });
    }
    reply = reply || "Done.";
    history.push({ role: "user", parts: [{ text: userText }] }, { role: "model", parts: [{ text: reply }] });
    saveHistory();
    return reply;
  }
  async function simple(prompt, parts = []) {
    const r = await gemini({
      systemInstruction: { parts: [{ text: await systemPrompt(prompt) }] },
      contents: [{ role: "user", parts: [...parts, { text: prompt }] }],
      generationConfig: genConfig(),
    });
    return textOf(r.candidates?.[0]?.content) || "I couldn't come up with an answer. Please try again.";
  }

  // ───────────────────────────── files ─────────────────────────────
  const toBase64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
  async function pdfText(file) {
    try {
      const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
      const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      let out = "";
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        out += (await page.getTextContent()).items.map((i) => i.str + (i.hasEOL ? "\n" : " ")).join("") + "\n\n";
      }
      return out;
    } catch { return ""; }
  }
  async function transcribe(blob, mime, what) {
    return simple(`Transcribe all the text in this ${what} (handwritten or printed) as clean notes. Describe any diagram in one or two lines. Output only the notes.`,
      [{ inlineData: { mimeType: mime, data: await toBase64(blob) } }]);
  }
  async function saveImage(blob, title) {
    const text = await transcribe(blob, blob.type || "image/jpeg", "image");
    title = title || `Photo note ${day(now())} ${new Date().toTimeString().slice(0, 5)}`;
    await addNote(title, text);
    return `Saved '${title}'. Here's what I read:\n\n${text.length > 700 ? text.slice(0, 700) + "..." : text}`;
  }
  async function saveDocument(file) {
    const title = file.name.replace(/\.[^.]+$/, "");
    let text = "";
    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
      text = await pdfText(file);
      if (text.trim().length < 40) {   // scanned PDF, or the PDF reader couldn't load: let Gemini read it
        if (file.size > 15 * 1024 * 1024) return "That PDF is too big for me to read (max 15 MB). Try sending its pages as photos.";
        text = await transcribe(file, "application/pdf", "PDF document");
      }
    } else text = await file.text();
    if (!text.trim()) return "That file has no readable text.";
    const n = await addNote(title, text);
    const summary = await simple(`I just saved a document titled '${title}'. In 3 short lines, tell me what it covers.\n\n${text.slice(0, 6000)}`);
    return `Saved '${title}' (${n} section${n > 1 ? "s" : ""}).\n\n${summary}`;
  }

  // ───────────────────────────── briefing & review ─────────────────────────────
  async function briefing() {
    const notes = await all("notes");
    const data = {
      reminders_next_48h: await listReminders(48),
      note_to_revise: notes.length ? (({ title, content }) => ({ title, content }))(notes[Math.floor(Math.random() * notes.length)]) : null,
      spending_last_7_days: await expenseSummary(7),
    };
    return simple("Write my morning briefing (max ~120 words, it will be read aloud). Greet me, list what's due soon, then give a 3-line revision of the note below with one quick question to test myself. Mention spending only if it looks high. End with a short motivating line.\n\n" + JSON.stringify(data));
  }
  async function review() {
    const since = now() - 7 * 864e5;
    const data = {
      notes_saved_this_week: (await all("notes")).filter((n) => n.at >= since).map((n) => n.title),
      things_taught_this_week: (await all("knowledge")).filter((k) => k.at >= since).map((k) => k.question),
      reminders_done_this_week: (await all("reminders")).filter((r) => r.done && r.due >= since).map((r) => r.text),
      upcoming_next_7_days: await listReminders(24 * 7),
      spending_this_week: await expenseSummary(7),
    };
    return simple("Write my weekly review (max ~180 words, it will be read aloud): what I studied and taught you, what's coming next week, spending by category, and 2 concrete suggestions for next week.\n\n" + JSON.stringify(data));
  }

  // ───────────────────────────── backup ─────────────────────────────
  async function exportAll() {
    const out = { app: "second-brain", version: 1, exported: new Date().toISOString(), settings: { name: settings.name, currency: settings.currency, model: settings.model } };
    for (const s of STORES) out[s] = await all(s);
    return out;
  }
  async function importAll(data) {
    if (!data || data.app !== "second-brain") throw new Error("That isn't a Second Brain backup file.");
    for (const s of STORES) { await clear(s); for (const row of data[s] || []) await put(s, row); }
    if (data.settings?.name) S.set("name", data.settings.name);
    if (data.settings?.currency) S.set("currency", data.settings.currency);
  }

  return {
    S, settings, NeedKey, checkKey, ask, simple, resetChat, stats,
    listKnowledge, learn, forgetLearned, listFacts, rememberFact, forgetFact,
    listReminders, cancelReminder, popDue, listNotes, expenseSummary,
    saveImage, saveDocument, briefing, review, exportAll, importAll,
    _test: { rank, chunk, runTool, systemPrompt, addReminder },
  };
})();
