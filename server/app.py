"""
Second Brain: phone app version.

This runs a small web server. Open it on your phone and tap "Add to Home screen":
it then works like a normal app (its own icon, full screen, no browser bar).
It uses the same brain.py and brain.db as the Telegram bot, so both see the same notes.

Run:  python app.py      then open  http://<your-laptop-IP>:8000  on your phone
"""

import os
import socket

import uvicorn
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import brain

APP_PASSWORD = os.getenv("APP_PASSWORD", "")
PORT = int(os.getenv("PORT", "8000"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
CHAT_KEY = "app"  # this app's short-term chat memory (separate from Telegram's)

app = FastAPI(title="Second Brain", docs_url=None, redoc_url=None)


@app.on_event("startup")
def startup():
    brain.init_client()
    if not APP_PASSWORD:
        brain.log.warning("APP_PASSWORD is empty: anyone on your network can open the app. Set one in .env.")


def check_key(x_app_key: str = Header(default="")):
    if APP_PASSWORD and x_app_key != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong or missing app password")


@app.exception_handler(Exception)
async def on_error(request: Request, exc: Exception):
    brain.log.exception("app error")
    return JSONResponse(status_code=500, content={"detail": f"Something went wrong: {exc}"})


class ChatIn(BaseModel):
    message: str
    teach: bool = False


class TeachIn(BaseModel):
    question: str
    answer: str


class FactIn(BaseModel):
    fact: str


class SpeakIn(BaseModel):
    text: str


# ─────────────────────────────── API ────────────────────────────────────────
@app.get("/api/status", dependencies=[Depends(check_key)])
def status():
    return {"name": brain.YOUR_NAME, "voice": brain.voice_on(), "tts_voice": brain.TTS_VOICE, "stats": brain.brain_stats()}


@app.post("/api/chat", dependencies=[Depends(check_key)])
async def chat(body: ChatIn):
    text = body.message.strip()
    if not text:
        raise HTTPException(400, "Empty message")
    reply = await brain.ask_claude(CHAT_KEY, text, teach=body.teach)
    return {"reply": reply, "stats": brain.brain_stats()}


@app.post("/api/upload", dependencies=[Depends(check_key)])
async def upload(file: UploadFile = File(...), title: str = Form(default="")):
    name = file.filename or "upload"
    ext = os.path.splitext(name)[1].lower()
    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "File is too large (max 20 MB).")
    if ext in brain.IMAGE_TYPES or (file.content_type or "").startswith("image/"):
        media = brain.IMAGE_TYPES.get(ext, file.content_type or "image/jpeg")
        reply = await brain.save_photo(data, media, title or None)
    elif ext in brain.TEXT_TYPES:
        reply = await brain.save_document(name, data, title or None)
    else:
        raise HTTPException(415, "I can read photos, PDF, .txt, .md and .csv files.")
    brain.HISTORY.setdefault(CHAT_KEY, []).extend(
        [{"role": "user", "content": f"[uploaded {name}]"}, {"role": "assistant", "content": reply}]
    )
    return {"reply": reply, "stats": brain.brain_stats()}


@app.get("/api/stats", dependencies=[Depends(check_key)])
def stats():
    return brain.brain_stats()


@app.get("/api/knowledge", dependencies=[Depends(check_key)])
def knowledge(q: str = ""):
    return brain.list_knowledge(q=q)


@app.post("/api/knowledge", dependencies=[Depends(check_key)])
def add_knowledge(body: TeachIn):
    if not body.question.strip() or not body.answer.strip():
        raise HTTPException(400, "Both question and answer are needed")
    return {"result": brain.learn(body.question, body.answer), "stats": brain.brain_stats()}


@app.delete("/api/knowledge/{kid}", dependencies=[Depends(check_key)])
def delete_knowledge(kid: int):
    return {"result": brain.forget_learned(kid), "stats": brain.brain_stats()}


@app.post("/api/tts", dependencies=[Depends(check_key)])
async def speak(body: SpeakIn):
    audio = await brain.tts(body.text)
    if not audio:
        raise HTTPException(503, "Voice is not available right now.")
    return Response(content=audio.getvalue(), media_type="audio/mpeg")


@app.get("/api/briefing", dependencies=[Depends(check_key)])
async def briefing():
    return {"reply": await brain.build_briefing()}


@app.get("/api/review", dependencies=[Depends(check_key)])
async def review():
    return {"reply": await brain.build_review()}


@app.get("/api/reminders", dependencies=[Depends(check_key)])
def reminders():
    return brain.list_reminders()


@app.delete("/api/reminders/{rid}", dependencies=[Depends(check_key)])
def delete_reminder(rid: int):
    return {"result": brain.cancel_reminder(rid)}


@app.get("/api/due", dependencies=[Depends(check_key)])
def due():
    """The app asks this every 30 s and shows a notification for anything due."""
    return brain.pop_due_reminders()


@app.get("/api/notes", dependencies=[Depends(check_key)])
def notes(q: str = ""):
    if q.strip():
        return [{"title": n["title"], "preview": n["content"][:160], "date": ""} for n in brain.search_notes(q, k=20)]
    return brain.list_notes()


@app.get("/api/me", dependencies=[Depends(check_key)])
def me():
    return brain.list_facts()


@app.post("/api/me", dependencies=[Depends(check_key)])
def add_fact(body: FactIn):
    if not body.fact.strip():
        raise HTTPException(400, "Empty fact")
    return {"result": brain.remember_fact(body.fact)}


@app.delete("/api/me/{fid}", dependencies=[Depends(check_key)])
def delete_fact(fid: int):
    return {"result": brain.forget_fact(fid)}


@app.get("/api/expenses", dependencies=[Depends(check_key)])
def expenses(days: int = 30):
    return brain.expense_summary(days)


@app.post("/api/reset", dependencies=[Depends(check_key)])
def reset():
    brain.HISTORY.pop(CHAT_KEY, None)
    return {"result": "Chat memory cleared."}


# ───────────────────────────── App files ────────────────────────────────────
@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"))


@app.get("/sw.js")
def service_worker():
    # served from the root so it can control the whole app
    return FileResponse(os.path.join(STATIC, "sw.js"), media_type="application/javascript")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "localhost"


if __name__ == "__main__":
    print("\n  Second Brain app is starting...")
    print(f"  On this computer:  http://localhost:{PORT}")
    print(f"  On your phone (same Wi-Fi):  http://{lan_ip()}:{PORT}\n")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
