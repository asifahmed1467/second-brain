/* app.js: the screens, the animated companion and its sky. All the thinking lives in brain.js. */
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const NS = "http://www.w3.org/2000/svg";
  const { S } = Brain;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let speakReplies = S.get("speak", "0") === "1";
  let teachMode = false, busy = false, stats = null;

  let toastT;
  function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 3400); }
  function handleError(e) {
    if (e && e.needKey) openSetup();
    return e?.message || String(e);
  }

  // ═════════════ THE SKY SCENE ═════════════
  const sky = $("#sky"), scene = $("#scene");
  let moodT;
  function mood(m, ms) { clearTimeout(moodT); sky.dataset.mood = m; if (ms) moodT = setTimeout(() => (sky.dataset.mood = "idle"), ms); }
  function rnd(seed) { let t = (seed * 2654435761) >>> 0; return () => { t += 0x6d2b79f5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
  function starPos(i) {
    const r = rnd(i * 97 + 13);
    for (let k = 0; k < 30; k++) { const x = 12 + r() * 336, y = 10 + r() * 150; if (Math.hypot(x - 180, y - 128) > 62) return [x, y]; }
    return [12 + r() * 336, 10 + r() * 40];
  }
  function svgEl(tag, attrs) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
  (function ambient() {
    const g = $("#ambient"), r = rnd(7);
    for (let i = 0; i < 38; i++) {
      const c = svgEl("circle", { cx: r() * 360, cy: r() * 190, r: (0.4 + r() * 0.8).toFixed(2), fill: "#C9CCFF", class: "star tw" });
      c.style.cssText = `--o:${(0.15 + r() * 0.35).toFixed(2)};--d:${(2 + r() * 4).toFixed(1)}s;--delay:-${(r() * 4).toFixed(1)}s`;
      g.appendChild(c);
    }
  })();
  let drawn = 0, noteStarsDrawn = 0;
  function drawStars(s, animateNew) {
    const g = $("#stars"), links = $("#links");
    const total = Math.min(s.taught, 120), noteStars = Math.min(s.notes, 30);
    if (total < drawn || noteStars < noteStarsDrawn) { g.innerHTML = ""; drawn = 0; noteStarsDrawn = 0; }
    for (let i = noteStarsDrawn; i < noteStars; i++) {
      const [x, y] = starPos(1000 + i), r = rnd(500 + i);
      const c = svgEl("circle", { cx: x, cy: y, r: 1.3, fill: "#7EE0C3", class: "star tw note" });
      c.style.cssText = `--o:.55;--d:${(3 + r() * 3).toFixed(1)}s;--delay:-${(r() * 3).toFixed(1)}s`;
      g.appendChild(c);
    }
    noteStarsDrawn = noteStars;
    for (let i = drawn; i < total; i++) {
      const [x, y] = starPos(i + 1), r = rnd(i + 3);
      const grp = svgEl("g", { class: "star" + (animateNew ? " new" : "") });
      const halo = svgEl("circle", { cx: x, cy: y, r: 5.5, fill: "#FFB547", opacity: 0.28 });
      const c = svgEl("circle", { cx: x, cy: y, r: 2.4, fill: "#FFE2B0", class: "star tw" });
      c.style.cssText = `--o:1;--d:${(2.5 + r() * 3).toFixed(1)}s;--delay:-${(r() * 3).toFixed(1)}s`;
      grp.append(halo, c);
      g.appendChild(grp);
    }
    drawn = total;
    links.innerHTML = "";
    const last = Math.min(total, 7);
    for (let i = total - last + 1; i < total; i++) {
      const [x1, y1] = starPos(i), [x2, y2] = starPos(i + 1);
      links.appendChild(svgEl("line", { x1, y1, x2, y2, class: "link" }));
    }
  }
  function toScreen(x, y) { const pt = scene.createSVGPoint(); pt.x = x; pt.y = y; const p = pt.matrixTransform(scene.getScreenCTM()); return [p.x, p.y]; }
  function flyStar(toIndex) {
    if (reduceMotion || sky.classList.contains("gone")) return Promise.resolve();
    const [sx, sy] = toScreen(180, 85), [tx, ty] = toScreen(...starPos(toIndex));
    const d = document.createElement("div"); d.className = "flyer"; document.body.appendChild(d);
    const midX = (sx + tx) / 2, midY = Math.min(sy, ty) - 40;
    return d.animate([
      { transform: `translate(${sx - 5}px,${sy - 5}px) scale(.4)` },
      { transform: `translate(${midX - 5}px,${midY - 5}px) scale(1.2)`, offset: 0.5 },
      { transform: `translate(${tx - 5}px,${ty - 5}px) scale(.8)` },
    ], { duration: 900, easing: "cubic-bezier(.3,.7,.2,1)" }).finished.then(() => d.remove());
  }
  function sayIt(text) { const s = $("#say"); s.textContent = text; s.classList.remove("go"); void s.offsetWidth; s.classList.add("go"); }
  function renderLevel(s) {
    $("#lvl").textContent = `Level ${s.level}`;
    $("#lvlFill").style.width = Math.max(4, s.progress * 100) + "%";
    $("#lvlNext").textContent = s.taught ? `${s.taught} taught, ${s.to_next} XP to level ${s.level + 1}` : "Teach me to grow";
  }
  async function refreshStats(celebrate = true) {
    const s = await Brain.stats();
    const old = stats; stats = s;
    if (!old || !celebrate) { drawStars(s, false); renderLevel(s); return; }
    const gained = s.taught - old.taught;
    if (gained > 0) {
      mood("learning", 2000);
      sayIt(`+${s.xp - old.xp} XP, learned ${gained} new`);
      for (let i = old.taught + 1; i <= Math.min(s.taught, 120); i++) await flyStar(i);
      drawStars(s, true);
    } else drawStars(s, false);
    renderLevel(s);
    if (s.level > old.level) {
      const f = $("#flash"); f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
      mood("happy", 1800); setTimeout(() => sayIt(`Level ${s.level}! My sky is growing`), 400);
      navigator.vibrate?.([60, 40, 120]);
    }
  }

  // ═════════════ TABS ═════════════
  function show(view) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === view));
    sky.classList.toggle("gone", !["chat", "teach"].includes(view));
    sky.classList.toggle("tall", view === "teach");
    sky.classList.toggle("compact", view === "chat" && !$("#hello"));
    ({ teach: loadKnowledge, reminders: loadReminders, notes: loadNotes, me: loadMe })[view]?.();
  }
  $$(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));

  // ═════════════ CHAT ═════════════
  const thread = $("#thread");
  const scrollDown = () => (thread.scrollTop = thread.scrollHeight);
  const I = {
    listen: '<svg class="ico" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
    fix: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    copy: '<svg class="ico" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  };
  function addMsg(text, who, cls = "") {
    if ($("#hello")) { $("#hello").remove(); sky.classList.add("compact"); }
    const el = document.createElement("div");
    el.className = `msg ${who} ${cls}`;
    el.textContent = text;
    if (who === "bot" && !cls.includes("err")) {
      const tools = document.createElement("div"); tools.className = "tools";
      tools.innerHTML = `<button type="button">${I.listen}Listen</button><button type="button">${I.fix}Correct this</button><button type="button">${I.copy}Copy</button>`;
      const [l, f, c] = tools.querySelectorAll("button");
      l.onclick = () => speak(text);
      f.onclick = () => { setTeach(true); input.value = "Correction: "; autosize(); input.focus(); updateSend(); };
      c.onclick = () => { navigator.clipboard?.writeText(text); toast("Copied"); };
      el.appendChild(tools);
    }
    thread.appendChild(el); scrollDown();
    return el;
  }

  async function run(label, fn, cls = "") {
    if (busy) return;
    busy = true; updateSend();
    if (label) addMsg(label, "me", cls);
    mood("thinking");
    const before = stats ? stats.taught : 0;
    try {
      const reply = await fn();
      mood("idle");
      const s = await Brain.stats();
      addMsg(reply, "bot", s.taught > before ? "learned" : "");
      await refreshStats();
      if (speakReplies) speak(reply);
      refreshBadge();
    } catch (e) { mood("idle"); addMsg(handleError(e), "bot", "err"); }
    finally { busy = false; updateSend(); }
  }
  function sendText(text, teach = teachMode) {
    text = text.trim(); if (!text) return;
    show("chat");
    run(text, () => Brain.ask(text, { teach }), teach ? "teach" : "");
  }

  const input = $("#input");
  function updateSend() { $("#sendBtn").disabled = busy || !input.value.trim(); }
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; }
  function setTeach(on) {
    teachMode = on;
    $("#modeAsk").setAttribute("aria-pressed", String(!on)); $("#modeTeach").setAttribute("aria-pressed", String(on));
    $("#composer").classList.toggle("teaching", on);
    input.placeholder = on ? "Teach me a fact, or correct my last answer" : "Ask me anything";
    if (on) mood("listening", 1200);
  }
  $("#modeAsk").onclick = () => setTeach(false);
  $("#modeTeach").onclick = () => setTeach(true);
  input.addEventListener("input", () => { autosize(); updateSend(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && matchMedia("(hover: hover)").matches) { e.preventDefault(); $("#composer").requestSubmit(); }
  });
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); const t = input.value; input.value = ""; autosize(); updateSend(); sendText(t); });
  $$(".chip").forEach((c) => c.addEventListener("click", () => {
    if (c.dataset.teach !== undefined) { setTeach(true); input.focus(); return; }
    sendText(c.dataset.say, false);
  }));

  // ── voice in: speech-to-text built into the phone ──
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $("#micBtn"); let rec = null;
  if (!SR) micBtn.classList.add("hidden");
  micBtn.addEventListener("click", () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = S.get("miclang", "en-US"); rec.interimResults = true;
    const prefix = input.value ? input.value.trim() + " " : "";
    rec.onresult = (ev) => { let t = ""; for (const r of ev.results) t += r[0].transcript; input.value = prefix + t; autosize(); updateSend(); };
    rec.onerror = (ev) => { if (ev.error === "not-allowed") toast("Allow microphone access to talk to me."); };
    rec.onend = () => { micBtn.classList.remove("listening"); rec = null; mood("idle"); if (input.value.trim()) $("#composer").requestSubmit(); };
    micBtn.classList.add("listening"); mood("listening"); rec.start();
  });
  $("#micLang").value = S.get("miclang", "en-US");
  $("#micLang").onchange = (e) => S.set("miclang", e.target.value);

  // ── voice out: the phone's own text-to-speech (free, works offline) ──
  function speak(text) {
    if (!("speechSynthesis" in window)) { toast("This phone can't read aloud."); return; }
    speechSynthesis.cancel();
    const bangla = /[ঀ-৿]/.test(text);
    const lang = bangla ? "bn-BD" : "en-US";
    const voices = speechSynthesis.getVoices();
    const voice = voices.find((v) => v.lang.replace("_", "-").startsWith(bangla ? "bn" : "en"));
    // long text is spoken in sentences, otherwise some phones stop half-way
    const parts = text.replace(/\s+/g, " ").match(/[^.!?।\n]+[.!?।]?/g) || [text];
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p.trim());
      u.lang = lang; if (voice) u.voice = voice;
      if (i === 0) u.onstart = () => mood("speaking");
      if (i === parts.length - 1) { u.onend = () => mood("idle"); u.onerror = () => mood("idle"); }
      speechSynthesis.speak(u);
    });
  }
  speechSynthesis?.getVoices?.();
  function setSpeak(on) {
    speakReplies = on; S.set("speak", on ? "1" : "0");
    $("#speakToggle").classList.toggle("on", on); $("#speakSwitch").classList.toggle("on", on);
    $("#waves").style.opacity = on ? 1 : 0.25;
    if (!on) window.speechSynthesis?.cancel();
  }
  $("#speakToggle").onclick = () => { setSpeak(!speakReplies); toast(speakReplies ? "I'll read replies aloud" : "Voice replies off"); };
  $("#speakSwitch").onclick = () => setSpeak(!speakReplies);
  setSpeak(speakReplies);

  $("#briefingBtn").onclick = () => { show("chat"); run("Morning briefing", async () => { const r = await Brain.briefing(); if (!speakReplies) speak(r); return r; }); };
  $("#reviewBtn").onclick = () => { show("chat"); run("Weekly review", () => Brain.review()); };

  // ── adding photos and files ──
  const sheet = $("#attachSheet");
  const openSheet = () => sheet.classList.add("show");
  $("#attachBtn").onclick = openSheet; $("#noteAdd").onclick = openSheet;
  sheet.onclick = (e) => { if (e.target === sheet) sheet.classList.remove("show"); };
  $$("[data-pick]").forEach((b) => (b.onclick = () => { sheet.classList.remove("show"); ({ camera: $("#pickCamera"), photo: $("#pickPhoto"), file: $("#pickFile") })[b.dataset.pick].click(); }));
  function shrink(file) {   // phone photos are huge: shrink to ~1600px JPEG before sending
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement("canvas");
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((b) => res(b || file), "image/jpeg", 0.85); URL.revokeObjectURL(img.src);
      };
      img.onerror = () => res(file); img.src = URL.createObjectURL(file);
    });
  }
  function upload(file) {
    if (!file) return;
    show("chat");
    const isImg = file.type.startsWith("image/");
    run(isImg ? "📷 Photo of my notes" : `📄 ${file.name}`, async () => (isImg ? Brain.saveImage(await shrink(file)) : Brain.saveDocument(file)));
  }
  ["#pickCamera", "#pickPhoto", "#pickFile"].forEach((id) => ($(id).onchange = (e) => { upload(e.target.files[0]); e.target.value = ""; }));

  // ═════════════ TEACH TAB ═════════════
  const X = '<svg class="ico" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  const STAR = '<svg class="ico" viewBox="0 0 24 24"><path d="m12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/></svg>';
  let kT;
  async function loadKnowledge() {
    const q = $("#knowQ").value.trim(), box = $("#knowList");
    const items = await Brain.listKnowledge(q);
    box.innerHTML = items.length ? items.map((k) => `
      <div class="item"><div class="dot sf">${STAR}</div>
        <div class="txt"><div class="t1">${esc(k.question)}</div><div class="t2">${esc(k.answer)}</div></div>
        <button class="x" data-id="${k.id}" aria-label="Forget this">${X}</button></div>`).join("")
      : `<div class="empty">${q ? "Nothing taught matches that." : "My sky is empty. Teach me your first fact above and watch a star appear."}</div>`;
    box.querySelectorAll(".x").forEach((b) => (b.onclick = async () => { await Brain.forgetLearned(b.dataset.id); toast("Forgotten"); refreshStats(false); loadKnowledge(); }));
  }
  $("#knowQ").oninput = () => { clearTimeout(kT); kT = setTimeout(loadKnowledge, 250); };
  $("#teachForm").onsubmit = async (e) => {
    e.preventDefault();
    const t = $("#teachInput").value.trim(); if (!t || busy) return;
    $("#teachInput").value = "";
    busy = true; mood("thinking");
    try { const r = await Brain.ask(t, { teach: true }); mood("idle"); toast(r.split("\n")[0]); await refreshStats(); loadKnowledge(); }
    catch (err) { mood("idle"); toast(handleError(err)); }
    finally { busy = false; }
  };

  // ═════════════ REMINDERS ═════════════
  const BELL = '<svg class="ico" viewBox="0 0 24 24"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>';
  async function loadReminders() {
    const box = $("#remList"), items = await Brain.listReminders();
    setBadge(items.length);
    box.innerHTML = items.length ? items.map((r) => `
      <div class="item"><div class="dot ac">${BELL}</div>
        <div class="txt"><div class="t1">${esc(r.text)}</div><div class="t2">${esc(r.due)}</div></div>
        <button class="x" data-id="${r.id}" aria-label="Cancel reminder">${X}</button></div>`).join("")
      : `<div class="empty">Nothing coming up. Add one above, or tell me in chat.</div>`;
    box.querySelectorAll(".x").forEach((b) => (b.onclick = async () => { await Brain.cancelReminder(b.dataset.id); toast("Reminder cancelled"); loadReminders(); }));
  }
  $("#remForm").onsubmit = async (e) => {
    e.preventDefault();
    const v = $("#remInput").value.trim(); if (!v) return; $("#remInput").value = "";
    try { const r = await Brain.ask(/^remind/i.test(v) ? v : "Remind me to " + v); toast(r.split("\n")[0]); loadReminders(); }
    catch (err) { toast(handleError(err)); }
  };
  function setBadge(n) { const b = $("#remBadge"); b.textContent = n; b.classList.toggle("show", n > 0); }
  async function refreshBadge() { setBadge((await Brain.listReminders()).length); }

  // ═════════════ NOTES ═════════════
  const BOOK = '<svg class="ico" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
  let nT;
  async function loadNotes() {
    const q = $("#noteQ").value.trim(), box = $("#noteList"), items = await Brain.listNotes(q);
    box.innerHTML = items.length ? items.map((n) => `
      <button class="item" style="text-align:left;width:100%" data-title="${esc(n.title)}"><div class="dot mt">${BOOK}</div>
        <div class="txt"><div class="t1">${esc(n.title)}</div><div class="t2 clamp">${esc(n.date)}: ${esc(n.preview)}</div></div></button>`).join("")
      : `<div class="empty">${q ? "No notes match that." : "No notes yet. Upload a PDF or a photo of your notebook."}</div>`;
    box.querySelectorAll("[data-title]").forEach((b) => (b.onclick = () => sendText(`Summarise my note "${b.dataset.title}" and ask me 3 quick questions on it`, false)));
  }
  $("#noteQ").oninput = () => { clearTimeout(nT); nT = setTimeout(loadNotes, 250); };
  $("#noteSearch").onsubmit = (e) => { e.preventDefault(); loadNotes(); };

  // ═════════════ ME ═════════════
  const PERSON = '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
  async function loadMe() {
    const box = $("#factList");
    const [facts, spend, s] = await Promise.all([Brain.listFacts(), Brain.expenseSummary(30), Brain.stats()]);
    box.innerHTML = facts.length ? facts.map((f) => `
      <div class="item"><div class="dot mt">${PERSON}</div><div class="txt"><div class="t1" style="font-weight:500">${esc(f.fact)}</div></div>
        <button class="x" data-id="${f.id}" aria-label="Forget this">${X}</button></div>`).join("")
      : `<div class="empty">I don't know anything about you yet.</div>`;
    box.querySelectorAll(".x").forEach((b) => (b.onclick = async () => { await Brain.forgetFact(b.dataset.id); loadMe(); refreshStats(false); }));
    $("#statTaught").textContent = s.taught; $("#statNotes").textContent = s.notes;
    $("#statSpend").textContent = (spend.currency || "") + Math.round(spend.total).toLocaleString();
    $("#modelState").textContent = Brain.settings.key ? `Free Google Gemini: ${Brain.settings.model}` : "No key yet: tap Edit";
  }
  $("#factForm").onsubmit = async (e) => {
    e.preventDefault();
    const v = $("#factInput").value.trim(); if (!v) return; $("#factInput").value = "";
    toast((await Brain.rememberFact(v)) === "Remembered." ? "Saved to your profile" : "I already knew that");
    loadMe(); refreshStats();
  };
  $("#resetBtn").onclick = () => { Brain.resetChat(); thread.innerHTML = ""; toast("Started a new conversation"); };

  // backup & restore (everything lives on this phone)
  $("#backupBtn").onclick = async () => {
    const data = await Brain.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const name = `second-brain-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([blob], name, { type: "application/json" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Second Brain backup" }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    toast("Backup saved to your downloads");
  };
  $("#restoreBtn").onclick = () => $("#pickBackup").click();
  $("#pickBackup").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    if (!confirm("Replace everything on this phone with this backup?")) return;
    try { await Brain.importAll(JSON.parse(await f.text())); toast("Backup restored"); stats = null; await refreshStats(false); loadMe(); greet(); }
    catch (err) { toast(err.message || "That file couldn't be read."); }
  };

  // ═════════════ SETUP (name + free Gemini key) ═════════════
  const setup = $("#setupSheet");
  function openSetup() {
    $("#sName").value = Brain.settings.name; $("#sKey").value = Brain.settings.key;
    $("#sModel").value = Brain.settings.model; $("#sCurrency").value = Brain.settings.currency;
    $("#setupErr").textContent = "";
    setup.classList.add("show");
  }
  $("#setupBtn").onclick = openSetup;
  setup.onclick = (e) => { if (e.target === setup && Brain.settings.key) setup.classList.remove("show"); };
  $("#setupForm").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("#sName").value.trim(), about = $("#sAbout").value.trim(), key = $("#sKey").value.trim();
    const model = $("#sModel").value.trim() || "gemini-2.5-flash", currency = $("#sCurrency").value.trim();
    const err = $("#setupErr");
    if (!name) { err.textContent = "Please enter your name."; return; }
    if (!key) { err.textContent = "Paste your Gemini key. Get it free at aistudio.google.com/apikey"; return; }
    const btn = $("#setupSave"); btn.disabled = true; btn.textContent = "Checking your key…"; err.textContent = "";
    try {
      await Brain.checkKey(key, model);
      const firstTime = !Brain.settings.name;
      S.set("name", name); S.set("gemini_key", key); S.set("model", model); S.set("currency", currency || "৳");
      if (firstTime || name) await Brain.rememberFact(`Name is ${name}`);
      if (about) await Brain.rememberFact(about);
      $("#sAbout").value = "";
      setup.classList.remove("show");
      greet(); refreshStats(); loadMe();
      toast(firstTime ? `Welcome, ${name.split(" ")[0]}! Teach me something.` : "Settings saved");
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; btn.textContent = "Save and start"; }
  };

  // ═════════════ reminder alerts while the app is open ═════════════
  function notifLabel() {
    const s = !("Notification" in window) ? "none" : Notification.permission;
    $("#notifState").textContent = s === "granted" ? "On while the app is open" : s === "denied" ? "Blocked in your phone settings" : s === "none" ? "Not supported on this phone" : "Pop up while the app is open";
    $("#notifBtn").classList.toggle("hidden", s !== "default");
  }
  $("#notifBtn").onclick = async () => { await Notification.requestPermission(); notifLabel(); };
  async function checkDue() {
    for (const r of await Brain.popDue()) {
      if ("Notification" in window && Notification.permission === "granted") {
        const reg = await navigator.serviceWorker?.getRegistration();
        try { reg ? reg.showNotification("Reminder", { body: r.text, icon: "icon-192.png" }) : new Notification("Reminder", { body: r.text }); } catch {}
      }
      navigator.vibrate?.([200, 100, 200]); toast("⏰ " + r.text); addMsg("⏰ " + r.text, "bot"); mood("happy", 1500);
    }
    refreshBadge();
  }

  // ═════════════ start ═════════════
  function greet() {
    const first = (Brain.settings.name || "").split(" ")[0];
    $("#subtitle").textContent = first ? `Hi ${first}, ready when you are` : "Your study companion";
    const h = $("#helloTitle"), hr = new Date().getHours();
    if (h && first) h.textContent = `Good ${hr < 12 ? "morning" : hr < 17 ? "afternoon" : "evening"}, ${first}. Ask me, or teach me.`;
  }
  greet(); notifLabel(); refreshStats(false); refreshBadge(); checkDue();
  if (!Brain.settings.key) openSetup();
  setInterval(checkDue, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkDue(); });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  window.__sb = { mood, refreshStats };
})();
