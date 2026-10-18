"""
brain.py: the shared "second brain" used by BOTH the Telegram bot and the mobile app.

It holds everything that isn't about a specific screen or chat app:
your notes, profile facts, reminders, expenses, the Claude conversation loop and text-to-speech.
"""

import base64
import io
import json
import logging
import os
import random
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, time as dtime, timezone
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

load_dotenv()

# ─────────────────────────── Settings (from .env) ───────────────────────────
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
OWNER_ID = int(os.getenv("OWNER_ID", "0") or 0)
YOUR_NAME = os.getenv("YOUR_NAME", "friend")
MODEL = os.getenv("CLAUDE_MODEL", "claude-haiku-5-5")
TZ = ZoneInfo(os.getenv("TIMEZONE", "UTC"))
BRIEFING_TIME = os.getenv("BRIEFING_TIME", "07:30")
REVIEW_TIME = os.getenv("REVIEW_TIME", "19:00")
TTS_VOICE = os.getenv("TTS_VOICE", "en-US-AriaNeural")
CURRENCY = os.getenv("CURRENCY", "")
DB_PATH = os.getenv("DB_PATH", "brain.db")

logging.basicConfig(format="%(asctime)s %(levelname)s %(message)s", level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("second-brain")

client = None  # AsyncAnthropic, created by init_client()
HISTORY: dict[int, list] = {}  # short chat memory per chat
MAX_HISTORY = 12


# ─────────────────────────────── Database ───────────────────────────────────
@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with db() as c:
        c.executescript(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS notes
                USING fts5(title, content, created_at UNINDEXED);
            CREATE TABLE IF NOT EXISTS reminders(
                id INTEGER PRIMARY KEY,
                text TEXT NOT NULL,
                due_utc TEXT NOT NULL,
                done INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS expenses(
                id INTEGER PRIMARY KEY,
                amount REAL NOT NULL,
                category TEXT,
                note TEXT,
                created_utc TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS profile(
                id INTEGER PRIMARY KEY,
                fact TEXT NOT NULL UNIQUE
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS knowledge
                USING fts5(question, answer, created_at UNINDEXED);
            """
        )
    load_profile_file()


# ─── Knowledge you teach it in chat ("training by chat") ───
# Every taught item is a question/answer pair. Before each reply the most relevant ones
# (plus the newest) are put in front of Claude, and Claude is told to trust them over its
# own general knowledge. That is how the bot "learns": no model retraining needed.
def learn(question: str, answer: str) -> str:
    question, answer = question.strip(), answer.strip()
    with db() as c:
        same = c.execute("SELECT rowid FROM knowledge WHERE question = ?", (question,)).fetchone()
        if same:  # a correction replaces what it learned before
            c.execute("UPDATE knowledge SET answer=?, created_at=? WHERE rowid=?", (answer, utcnow_iso(), same["rowid"]))
            return f"Updated what I know (#{same['rowid']})."
        cur = c.execute(
            "INSERT INTO knowledge(question, answer, created_at) VALUES (?, ?, ?)", (question, answer, utcnow_iso())
        )
    return f"Learned (#{cur.lastrowid})."


def _fts_query(text: str) -> str:
    words = [w for w in re.findall(r"\w+", text.lower()) if len(w) > 1 and w not in STOPWORDS]
    return " OR ".join(f'"{w}"' for w in words)


def search_knowledge(text: str, k: int = 8) -> list[dict]:
    q = _fts_query(text)
    if not q:
        return []
    with db() as c:
        rows = c.execute(
            "SELECT rowid AS id, question, answer FROM knowledge WHERE knowledge MATCH ? ORDER BY rank LIMIT ?",
            (q, k),
        ).fetchall()
    return [dict(r) for r in rows]


def list_knowledge(limit: int = 100, q: str = "") -> list[dict]:
    if q.strip():
        return search_knowledge(q, k=limit)
    with db() as c:
        rows = c.execute(
            "SELECT rowid AS id, question, answer FROM knowledge ORDER BY rowid DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def forget_learned(kid: int) -> str:
    with db() as c:
        n = c.execute("DELETE FROM knowledge WHERE rowid=?", (kid,)).rowcount
    return f"Forgot #{kid}." if n else f"Nothing learned with #{kid}."


def brain_stats() -> dict:
    """A simple 'level' that grows as you teach it: drives the app's level-up animation."""
    with db() as c:
        taught = c.execute("SELECT count(*) FROM knowledge").fetchone()[0]
        notes = c.execute("SELECT count(*) FROM notes").fetchone()[0]
        facts = c.execute("SELECT count(*) FROM profile").fetchone()[0]
    xp = taught * 3 + facts * 2 + notes
    level = 1 + int((xp / 5) ** 0.5)
    lo, hi = 5 * (level - 1) ** 2, 5 * level ** 2
    return {
        "taught": taught,
        "notes": notes,
        "facts": facts,
        "xp": xp,
        "level": level,
        "progress": round((xp - lo) / (hi - lo), 3),
        "to_next": hi - xp,
    }


# ─── Profile: facts about you, read before every reply ───
PROFILE_FILE = os.getenv("PROFILE_FILE", "profile.txt")


def load_profile_file():
    """Import facts from profile.txt (one per line). Safe to run on every start."""
    if not os.path.exists(PROFILE_FILE):
        return
    with open(PROFILE_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip().lstrip("-•* ").strip()
            if line and not line.startswith("#") and "[fill in" not in line:
                remember_fact(line)


def remember_fact(fact: str) -> str:
    fact = fact.strip()
    with db() as c:
        cur = c.execute("INSERT OR IGNORE INTO profile(fact) VALUES (?)", (fact,))
    return "Remembered." if cur.rowcount else "I already knew that."


def list_facts() -> list[dict]:
    with db() as c:
        rows = c.execute("SELECT id, fact FROM profile ORDER BY id").fetchall()
    return [{"id": r["id"], "fact": r["fact"]} for r in rows]


def forget_fact(fid: int) -> str:
    with db() as c:
        n = c.execute("DELETE FROM profile WHERE id=?", (fid,)).rowcount
    return f"Forgot fact #{fid}." if n else f"No fact #{fid}."


def utcnow_iso(dt: datetime | None = None) -> str:
    dt = dt or datetime.now(timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def to_local(iso_utc: str) -> datetime:
    return datetime.strptime(iso_utc, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).astimezone(TZ)


def get_setting(key, default=None):
    with db() as c:
        row = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key, value):
    with db() as c:
        c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", (key, str(value)))


# ─── Notes (full-text search = simple, fast, zero extra setup) ───
def chunk_text(text: str, size: int = 1200, overlap: int = 150) -> list[str]:
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]
    chunks, start = [], 0
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):  # prefer to cut at a paragraph or sentence
            cut = text.rfind("\n", start + size // 2, end)
            if cut == -1:
                cut = text.rfind(". ", start + size // 2, end)
            if cut != -1:
                end = cut + 1
        chunks.append(text[start:end].strip())
        if end >= len(text):
            break
        start = max(end - overlap, start + 1)
    return [c for c in chunks if c]


def add_note(title: str, content: str) -> int:
    parts = chunk_text(content)
    now = utcnow_iso()
    with db() as c:
        for i, part in enumerate(parts):
            t = title if len(parts) == 1 else f"{title} (part {i + 1})"
            c.execute("INSERT INTO notes(title, content, created_at) VALUES (?, ?, ?)", (t, part, now))
    return len(parts)


STOPWORDS = set(
    "a an the is are was were be to of in on for and or what how why when which who me my i "
    "about tell explain give from with this that it do does did can please".split()
)


def search_notes(query: str, k: int = 5) -> list[dict]:
    words = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 1 and w not in STOPWORDS]
    if not words:
        return []
    fts_query = " OR ".join(f'"{w}"' for w in words)
    with db() as c:
        rows = c.execute(
            "SELECT title, content FROM notes WHERE notes MATCH ? ORDER BY rank LIMIT ?",
            (fts_query, k),
        ).fetchall()
    return [dict(r) for r in rows]


def recent_note_titles(limit: int = 15) -> list[str]:
    with db() as c:
        rows = c.execute(
            "SELECT title, created_at FROM notes ORDER BY rowid DESC LIMIT ?", (limit,)
        ).fetchall()
    return [f"{r['title']} ({to_local(r['created_at']):%d %b})" for r in rows]


def random_note() -> dict | None:
    with db() as c:
        row = c.execute("SELECT title, content FROM notes ORDER BY random() LIMIT 1").fetchone()
    return dict(row) if row else None


# ─── Reminders ───
def add_reminder(text: str, due_local: str) -> str:
    try:
        dt = datetime.strptime(due_local.strip(), "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
    except ValueError:
        return "Error: due_local must look like 'YYYY-MM-DD HH:MM'."
    with db() as c:
        cur = c.execute(
            "INSERT INTO reminders(text, due_utc) VALUES (?, ?)", (text, utcnow_iso(dt))
        )
        rid = cur.lastrowid
    warn = " (note: that time is already in the past)" if dt < datetime.now(TZ) else ""
    return f"Reminder #{rid} set for {dt:%a %d %b %Y, %I:%M %p}{warn}."


def list_reminders(hours: int | None = None) -> list[dict]:
    q = "SELECT id, text, due_utc FROM reminders WHERE done=0"
    args: tuple = ()
    if hours is not None:
        q += " AND due_utc <= ?"
        args = (utcnow_iso(datetime.now(timezone.utc) + timedelta(hours=hours)),)
    with db() as c:
        rows = c.execute(q + " ORDER BY due_utc", args).fetchall()
    return [
        {"id": r["id"], "text": r["text"], "due": f"{to_local(r['due_utc']):%a %d %b, %I:%M %p}"}
        for r in rows
    ]


def cancel_reminder(rid: int) -> str:
    with db() as c:
        n = c.execute("UPDATE reminders SET done=1 WHERE id=? AND done=0", (rid,)).rowcount
    return f"Reminder #{rid} cancelled." if n else f"No active reminder #{rid}."


# ─── Expenses ───
def log_expense(amount: float, category: str, note: str = "") -> str:
    with db() as c:
        c.execute(
            "INSERT INTO expenses(amount, category, note, created_utc) VALUES (?, ?, ?, ?)",
            (float(amount), category.lower().strip(), note, utcnow_iso()),
        )
    return f"Logged {CURRENCY}{float(amount):g} for {category}."


def expense_summary(days: int = 30) -> dict:
    since = utcnow_iso(datetime.now(timezone.utc) - timedelta(days=days))
    with db() as c:
        rows = c.execute(
            "SELECT category, SUM(amount) AS total, COUNT(*) AS n FROM expenses "
            "WHERE created_utc >= ? GROUP BY category ORDER BY total DESC",
            (since,),
        ).fetchall()
    by_cat = {r["category"]: round(r["total"], 2) for r in rows}
    return {"days": days, "currency": CURRENCY, "total": round(sum(by_cat.values()), 2), "by_category": by_cat}


# ──────────────────────────── Claude tools ──────────────────────────────────
TOOLS = [
    {
        "name": "learn",
        "description": "Permanently learn something the user TEACHES you or a CORRECTION to your answer, so you answer it their way from now on. Use whenever they say 'learn this', 'teach', 'remember that X is Y', 'that's wrong', 'actually...', 'no, the answer is...', or give you a definition, rule, formula, shortcut, local info (rooms, teachers, deadlines, procedures). One idea per call. 'question' = how it would be asked later (e.g. 'Where is the AIUB CSE department office?'); 'answer' = the correct information, complete enough to stand alone. Re-using the exact same question replaces the old answer. Personal facts about the user go to remember_about_me; long study material goes to save_note.",
        "input_schema": {
            "type": "object",
            "properties": {"question": {"type": "string"}, "answer": {"type": "string"}},
            "required": ["question", "answer"],
        },
    },
    {
        "name": "forget_learned",
        "description": "Delete something you learned, by its # id (shown in the system prompt), when the user says it is wrong or to forget it.",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "integer"}},
            "required": ["id"],
        },
    },
    {
        "name": "remember_about_me",
        "description": "Store a lasting fact about the user themself: name, university, department, semester, courses, goals, schedule, preferences, family, how they like answers. Use whenever they say 'remember that...', 'my name is...', 'I am a student of...' or share a personal detail that would help later. One fact per call, written in third person, e.g. 'Studies CSE at AIUB, final year'. If a new fact replaces an old one, call forget_about_me on the old one first.",
        "input_schema": {
            "type": "object",
            "properties": {"fact": {"type": "string"}},
            "required": ["fact"],
        },
    },
    {
        "name": "forget_about_me",
        "description": "Delete a stored personal fact by its id (the ids are shown in the system prompt).",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "integer"}},
            "required": ["id"],
        },
    },
    {
        "name": "save_note",
        "description": "Save something to the user's personal notes (ideas, facts, class notes, links, anything they want to remember).",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short title, e.g. 'OS - deadlocks'"},
                "content": {"type": "string"},
            },
            "required": ["title", "content"],
        },
    },
    {
        "name": "search_notes",
        "description": "Search the user's saved notes, PDFs and photo notes. ALWAYS use this before explaining, summarising or quizzing on a study topic, or when the user asks about something they told you before. Use specific keywords.",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Keywords to search for"}},
            "required": ["query"],
        },
    },
    {
        "name": "list_recent_notes",
        "description": "List titles of the most recently saved notes.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "add_reminder",
        "description": "Create a reminder. Convert relative times ('Friday 5pm', 'in 2 hours', 'tomorrow morning' = 09:00) into an exact local time using the current date/time given in the system prompt.",
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "What to remind about"},
                "due_local": {"type": "string", "description": "Local time as 'YYYY-MM-DD HH:MM' (24h)"},
            },
            "required": ["text", "due_local"],
        },
    },
    {
        "name": "list_reminders",
        "description": "List upcoming (not yet sent) reminders with their ids.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "cancel_reminder",
        "description": "Cancel a reminder by id (call list_reminders first if you don't know the id).",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "integer"}},
            "required": ["id"],
        },
    },
    {
        "name": "log_expense",
        "description": "Record money the user spent.",
        "input_schema": {
            "type": "object",
            "properties": {
                "amount": {"type": "number"},
                "category": {"type": "string", "description": "e.g. food, travel, books, rent, fun, other"},
                "note": {"type": "string"},
            },
            "required": ["amount", "category"],
        },
    },
    {
        "name": "expense_summary",
        "description": "Get total spending by category over the last N days.",
        "input_schema": {
            "type": "object",
            "properties": {"days": {"type": "integer", "description": "Default 30"}},
        },
    },
]


def run_tool(name: str, args: dict) -> str:
    if name == "learn":
        return learn(args["question"], args["answer"])
    if name == "forget_learned":
        return forget_learned(int(args["id"]))
    if name == "remember_about_me":
        return remember_fact(args["fact"])
    if name == "forget_about_me":
        return forget_fact(int(args["id"]))
    if name == "save_note":
        n = add_note(args["title"], args["content"])
        return f"Saved note '{args['title']}' ({n} chunk{'s' if n > 1 else ''})."
    if name == "search_notes":
        hits = search_notes(args["query"])
        return json.dumps(hits, ensure_ascii=False) if hits else "No matching notes found."
    if name == "list_recent_notes":
        titles = recent_note_titles()
        return "\n".join(titles) if titles else "No notes saved yet."
    if name == "add_reminder":
        return add_reminder(args["text"], args["due_local"])
    if name == "list_reminders":
        items = list_reminders()
        return json.dumps(items, ensure_ascii=False) if items else "No upcoming reminders."
    if name == "cancel_reminder":
        return cancel_reminder(int(args["id"]))
    if name == "log_expense":
        return log_expense(args["amount"], args["category"], args.get("note", ""))
    if name == "expense_summary":
        return json.dumps(expense_summary(int(args.get("days", 30))), ensure_ascii=False)
    return f"Unknown tool {name}"


def taught_context(query: str) -> str:
    """Relevant taught items for this message, plus the newest few."""
    items = {k["id"]: k for k in search_knowledge(query)} if query else {}
    for k in list_knowledge(limit=5):
        items.setdefault(k["id"], k)
    return "\n".join(f"#{k['id']} Q: {k['question']}\n    A: {k['answer']}" for k in items.values()) or "(nothing taught yet)"


def system_prompt(query: str = "") -> str:
    now = datetime.now(TZ)
    facts = list_facts()
    about = "\n".join(f"[{f['id']}] {f['fact']}" for f in facts) or "(nothing yet)"
    return f"""You are the personal "second brain" assistant of {YOUR_NAME}, a university student, chatting with them on their phone.
Current local date/time: {now:%A %d %B %Y, %H:%M} ({TZ.key}).

What you know about {YOUR_NAME} (fact id in brackets). Use this naturally to personalise answers, plans and examples:
{about}

Things {YOUR_NAME} has TAUGHT you (# id). These are your training: when one is relevant, answer with it, and trust it over your general knowledge:
{taught_context(query)}

How to behave:
- When the user teaches you something or corrects you, call learn (one call per idea), then confirm in one short line what you learned. If a correction contradicts a taught item, reuse that item's exact question so it gets replaced.
- When the user tells you something about themself worth keeping, store it with remember_about_me and confirm in a few words.
- Use your tools to save notes, search notes, set reminders and track expenses whenever the message calls for it. Don't ask for confirmation for simple saves or reminders, just do it and confirm briefly.
- For study questions, explanations, summaries or quizzes: search the notes first and base the answer on them. If the notes don't cover it, say so in one line, then answer from general knowledge.
- Quizzes: ask one question at a time, wait for the answer, then give feedback and the next question.
- Keep replies short and friendly: this is a phone chat. Use plain text with simple dashes for lists; avoid markdown symbols like ** or ###.
- Never invent things the user supposedly saved."""


def blocks_to_dicts(content) -> list[dict]:
    out = []
    for b in content:
        if b.type == "text":
            out.append({"type": "text", "text": b.text})
        elif b.type == "tool_use":
            out.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
    return out


TEACH_PREFIX = (
    "[TEACH MODE: I am training you. Store every useful piece of information in this message with the "
    "learn tool (one call per idea; personal facts about me go to remember_about_me). If it corrects your "
    "previous answer, learn the corrected version. Then reply with one or two short lines listing what you "
    "learned. Don't answer anything else.]\n\n"
)


async def ask_claude(chat_id, user_content, history_label: str | None = None, teach: bool = False) -> str:
    history = HISTORY.setdefault(chat_id, [])
    query = user_content if isinstance(user_content, str) else ""
    sent = TEACH_PREFIX + user_content if teach and isinstance(user_content, str) else user_content
    messages = history[-MAX_HISTORY:] + [{"role": "user", "content": sent}]
    resp = None
    for _ in range(8):  # tool-use loop
        resp = await client.messages.create(
            model=MODEL,
            max_tokens=1500,
            system=system_prompt(query),
            tools=TOOLS,
            messages=messages,
        )
        messages.append({"role": "assistant", "content": blocks_to_dicts(resp.content)})
        if resp.stop_reason != "tool_use":
            break
        results = []
        for b in resp.content:
            if b.type == "tool_use":
                try:
                    out = run_tool(b.name, b.input)
                except Exception as e:  # keep the chat alive if a tool fails
                    log.exception("tool error")
                    out = f"Error: {e}"
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": out})
        messages.append({"role": "user", "content": results})

    text = "\n".join(b.text for b in resp.content if b.type == "text").strip() if resp else ""
    text = text or "Done."
    label = history_label or (user_content if isinstance(user_content, str) else "[sent a file]")
    history.extend([{"role": "user", "content": label}, {"role": "assistant", "content": text}])
    del history[:-MAX_HISTORY]
    return text


async def simple_claude(prompt: str, max_tokens: int = 700) -> str:
    resp = await client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        system=system_prompt(),
        messages=[{"role": "user", "content": prompt}],
    )
    return "\n".join(b.text for b in resp.content if b.type == "text").strip()


# ───────────────────────────── Text-to-speech ───────────────────────────────
def clean_for_speech(text: str) -> str:
    text = re.sub(r"https?://\S+", "link", text)
    text = re.sub(r"[*_#`>|~]", "", text)
    text = re.sub(r"^\s*[-•]\s*", "", text, flags=re.M)
    return text.strip()


async def tts(text: str) -> io.BytesIO | None:
    try:
        import edge_tts

        communicate = edge_tts.Communicate(clean_for_speech(text)[:4000], TTS_VOICE)
        buf = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                buf.write(chunk["data"])
        if buf.tell() == 0:
            return None
        buf.seek(0)
        buf.name = "second-brain.mp3"
        return buf
    except Exception:
        log.exception("TTS failed")
        return None



def voice_on() -> bool:
    return get_setting("voice", "off") == "on"



async def build_briefing() -> str:
    data = {
        "reminders_next_48h": list_reminders(hours=48),
        "note_to_revise": random_note(),
        "spending_last_7_days": expense_summary(7),
    }
    return await simple_claude(
        "Write my morning briefing (max ~120 words, it will also be read aloud). "
        "Greet me, list what's due soon, then give a 3-line revision of the note below with one quick "
        "question to test myself. Mention spending only if it looks high. End with a short motivating line.\n\n"
        + json.dumps(data, ensure_ascii=False)
    )


async def build_review() -> str:
    since = utcnow_iso(datetime.now(timezone.utc) - timedelta(days=7))
    with db() as c:
        notes = [r["title"] for r in c.execute("SELECT title FROM notes WHERE created_at >= ?", (since,))]
        done = [r["text"] for r in c.execute("SELECT text FROM reminders WHERE done=1 AND due_utc >= ?", (since,))]
    data = {
        "notes_saved_this_week": notes,
        "reminders_completed_this_week": done,
        "upcoming_next_7_days": list_reminders(hours=24 * 7),
        "spending_this_week": expense_summary(7),
    }
    return await simple_claude(
        "Write my weekly review (max ~180 words, it will also be read aloud): what I studied, what's coming "
        "next week, spending by category, and 2 concrete suggestions for next week.\n\n"
        + json.dumps(data, ensure_ascii=False)
    )




def parse_hhmm(value: str) -> dtime:
    h, m = map(int, value.split(":"))
    return dtime(h, m, tzinfo=TZ)


# ───────────────────────── Shared helpers for bot + app ─────────────────────
def init_client():
    """Create the Claude client and the database. Call once at startup."""
    global client
    if not ANTHROPIC_API_KEY:
        raise SystemExit("Set ANTHROPIC_API_KEY in your .env file (see README.md).")
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    init_db()


TEXT_TYPES = (".pdf", ".txt", ".md", ".csv")
IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}


def extract_text(filename: str, data: bytes) -> str:
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        return "\n".join((p.extract_text() or "") for p in reader.pages)
    return data.decode("utf-8", errors="ignore")


async def save_document(filename: str, data: bytes, title: str | None = None) -> str:
    """Save a PDF/text file as notes. Returns a reply for the user."""
    text = extract_text(filename, data)
    if not text.strip():
        return "That file has no readable text (probably a scanned PDF). Send the pages as photos and I'll read them."
    title = title or os.path.splitext(filename)[0]
    n = add_note(title, text)
    summary = await simple_claude(
        f"I just saved a document titled '{title}'. In 3 short lines, tell me what it covers.\n\n{text[:6000]}",
        max_tokens=300,
    )
    return f"Saved '{title}' ({n} sections).\n\n{summary}"


async def save_photo(data: bytes, media_type: str = "image/jpeg", title: str | None = None) -> str:
    """Read handwritten/printed notes from a photo and save them. Returns a reply for the user."""
    resp = await client.messages.create(
        model=MODEL,
        max_tokens=2000,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": base64.b64encode(data).decode()}},
                    {
                        "type": "text",
                        "text": "Transcribe all the text in this image (handwritten or printed) as clean notes. "
                        "Describe any diagram in one or two lines. Output only the notes.",
                    },
                ],
            }
        ],
    )
    text = "\n".join(b.text for b in resp.content if b.type == "text").strip()
    if not text:
        return "I couldn't read anything in that photo."
    title = title or f"Photo note {datetime.now(TZ):%d %b %H:%M}"
    add_note(title, text)
    preview = text if len(text) < 700 else text[:700] + "..."
    return f"Saved '{title}'. Here's what I read:\n\n{preview}"


def pop_due_reminders() -> list[dict]:
    """Return reminders whose time has come and mark them as sent."""
    with db() as c:
        rows = c.execute(
            "SELECT id, text FROM reminders WHERE done=0 AND due_utc <= ?", (utcnow_iso(),)
        ).fetchall()
        for r in rows:
            c.execute("UPDATE reminders SET done=1 WHERE id=?", (r["id"],))
    return [{"id": r["id"], "text": r["text"]} for r in rows]


def list_notes(limit: int = 50) -> list[dict]:
    with db() as c:
        rows = c.execute(
            "SELECT rowid AS id, title, substr(content, 1, 160) AS preview, created_at FROM notes ORDER BY rowid DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [
        {"id": r["id"], "title": r["title"], "preview": r["preview"], "date": f"{to_local(r['created_at']):%d %b}"}
        for r in rows
    ]
