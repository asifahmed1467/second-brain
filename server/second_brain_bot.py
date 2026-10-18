"""
Second Brain: Telegram version. The shared logic lives in brain.py.

Run:  python second_brain_bot.py      (see README.md for setup)
For the phone app instead, run:  python app.py
"""

import logging
import os
from functools import wraps

from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

import brain
from brain import (
    BRIEFING_TIME,
    HISTORY,
    OWNER_ID,
    REVIEW_TIME,
    TELEGRAM_TOKEN,
    TZ,
    ask_claude,
    build_briefing,
    build_review,
    list_facts,
    parse_hhmm,
    pop_due_reminders,
    recent_note_titles,
    set_setting,
    tts,
    voice_on,
)

log = logging.getLogger("second-brain")


# ──────────────────────────── Telegram helpers ──────────────────────────────
async def send(bot, chat_id: int, text: str, speak: bool = False):
    for i in range(0, len(text), 4000):
        await bot.send_message(chat_id, text[i : i + 4000])
    if speak:
        await bot.send_chat_action(chat_id, ChatAction.RECORD_VOICE)
        audio = await tts(text)
        if audio:
            await bot.send_audio(chat_id, audio=audio, title="Second Brain", performer="Claude")


def owner_only(func):
    @wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        uid = update.effective_user.id if update.effective_user else 0
        if OWNER_ID == 0:
            await update.effective_message.reply_text(
                f"Setup step: your Telegram user ID is {uid}.\n"
                f"Put OWNER_ID={uid} in your .env file and restart me."
            )
            return
        if uid != OWNER_ID:
            return  # silently ignore everyone else: this bot is private
        try:
            return await func(update, context)
        except Exception as e:
            log.exception("handler error")
            await update.effective_message.reply_text(f"Something went wrong: {e}")

    return wrapper


# ─────────────────────────────── Handlers ───────────────────────────────────
HELP = """Hi! I'm your Second Brain. Just talk to me normally:

- "Note: Dijkstra fails with negative edge weights"
- Send a PDF, .txt file or a photo of your notes to save it
- "Explain deadlocks from my OS notes"
- "Quiz me on DBMS normalization"
- "Remind me to submit the lab file Friday 5pm"
- "What reminders do I have?"
- "Spent 120 on lunch" / "How much did I spend this week?"

Commands:
/voice - turn voice replies on/off
/speak - reply to any message with /speak and I'll read it aloud
/briefing - get today's briefing now
/review - get the weekly review now
/notes - see recently saved notes
/teach - train me: /teach <fact or correction>
/brain - my level and what you've taught me
/me - see what I know about you ("My name is...", "Remember that I...")
/reset - clear my short-term chat memory"""


@owner_only
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(HELP)


@owner_only
async def cmd_voice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    new = "off" if voice_on() else "on"
    set_setting("voice", new)
    await update.message.reply_text(f"Voice replies are now {new.upper()}.")


@owner_only
async def cmd_speak(update: Update, context: ContextTypes.DEFAULT_TYPE):
    target = update.message.reply_to_message
    text = (target.text or target.caption) if target else " ".join(context.args)
    if not text:
        await update.message.reply_text("Reply to a message with /speak, or type /speak your text.")
        return
    await update.message.chat.send_action(ChatAction.RECORD_VOICE)
    audio = await tts(text)
    if audio:
        await update.message.reply_audio(audio=audio, title="Second Brain", performer="Claude")
    else:
        await update.message.reply_text("Couldn't generate audio right now.")


@owner_only
async def cmd_notes(update: Update, context: ContextTypes.DEFAULT_TYPE):
    titles = recent_note_titles(20)
    await update.message.reply_text("Recent notes:\n" + "\n".join(f"- {t}" for t in titles) if titles else "No notes yet.")


@owner_only
async def cmd_me(update: Update, context: ContextTypes.DEFAULT_TYPE):
    facts = list_facts()
    if not facts:
        await update.message.reply_text('I don\'t know anything about you yet. Tell me, e.g. "My name is ... and I study ... at ..."')
        return
    lines = "\n".join(f"{f['id']}. {f['fact']}" for f in facts)
    await update.message.reply_text(f"What I know about you:\n{lines}\n\nTo remove one, say \"forget fact 3\".")


@owner_only
async def cmd_teach(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = " ".join(context.args)
    if not text:
        await update.message.reply_text(
            "Teach me anything: /teach The CSE office is in Annex 4, room 402\n"
            "Or just say \"learn this: ...\" or \"that's wrong, the answer is ...\" in normal chat."
        )
        return
    await update.message.chat.send_action(ChatAction.TYPING)
    reply = await ask_claude(update.effective_chat.id, text, teach=True)
    s = brain.brain_stats()
    await send(context.bot, update.effective_chat.id, f"{reply}\n\n🧠 Level {s['level']} · {s['taught']} things taught")


@owner_only
async def cmd_brain(update: Update, context: ContextTypes.DEFAULT_TYPE):
    s = brain.brain_stats()
    items = brain.list_knowledge(limit=10)
    lines = "\n".join(f"#{k['id']} {k['question']}" for k in items) or "Nothing yet. Use /teach."
    await update.message.reply_text(
        f"🧠 Level {s['level']} ({s['to_next']} XP to next)\n"
        f"Taught: {s['taught']} · Notes: {s['notes']} · About you: {s['facts']}\n\nLatest things you taught me:\n{lines}\n\n"
        "Say \"forget #3\" to remove one."
    )


@owner_only
async def cmd_reset(update: Update, context: ContextTypes.DEFAULT_TYPE):
    HISTORY.pop(update.effective_chat.id, None)
    await update.message.reply_text("Short-term memory cleared. Your saved notes are untouched.")


@owner_only
async def cmd_briefing(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.chat.send_action(ChatAction.TYPING)
    await send(context.bot, update.effective_chat.id, await build_briefing(), speak=True)


@owner_only
async def cmd_review(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.chat.send_action(ChatAction.TYPING)
    await send(context.bot, update.effective_chat.id, await build_review(), speak=True)


@owner_only
async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.chat.send_action(ChatAction.TYPING)
    reply = await ask_claude(update.effective_chat.id, update.message.text)
    await send(context.bot, update.effective_chat.id, reply, speak=voice_on())


@owner_only
async def on_document(update: Update, context: ContextTypes.DEFAULT_TYPE):
    doc = update.message.document
    name = doc.file_name or "document"
    if os.path.splitext(name)[1].lower() not in brain.TEXT_TYPES:
        await update.message.reply_text("I can read PDF, .txt, .md and .csv files. For images, send them as photos.")
        return
    await update.message.chat.send_action(ChatAction.TYPING)
    file = await doc.get_file()
    data = bytes(await file.download_as_bytearray())
    reply = await brain.save_document(name, data, update.message.caption)
    await send(context.bot, update.effective_chat.id, reply)


@owner_only
async def on_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.chat.send_action(ChatAction.TYPING)
    photo = update.message.photo[-1]  # highest resolution
    file = await photo.get_file()
    data = bytes(await file.download_as_bytearray())
    reply = await brain.save_photo(data, "image/jpeg", update.message.caption)
    await send(context.bot, update.effective_chat.id, reply)


# ─────────────────────────── Scheduled jobs ─────────────────────────────────
async def check_reminders(context: ContextTypes.DEFAULT_TYPE):
    for r in pop_due_reminders():
        await context.bot.send_message(OWNER_ID, f"⏰ Reminder: {r['text']}")


async def briefing_job(context: ContextTypes.DEFAULT_TYPE):
    await send(context.bot, OWNER_ID, await build_briefing(), speak=True)


async def review_job(context: ContextTypes.DEFAULT_TYPE):
    await send(context.bot, OWNER_ID, await build_review(), speak=True)


# ────────────────────────────────── Main ────────────────────────────────────
def main():
    if not TELEGRAM_TOKEN:
        raise SystemExit("Set TELEGRAM_TOKEN in your .env file (see README.md).")
    brain.init_client()

    app = Application.builder().token(TELEGRAM_TOKEN).build()
    app.add_handler(CommandHandler(["start", "help"], cmd_start))
    app.add_handler(CommandHandler("voice", cmd_voice))
    app.add_handler(CommandHandler("speak", cmd_speak))
    app.add_handler(CommandHandler("notes", cmd_notes))
    app.add_handler(CommandHandler("me", cmd_me))
    app.add_handler(CommandHandler("teach", cmd_teach))
    app.add_handler(CommandHandler("brain", cmd_brain))
    app.add_handler(CommandHandler("reset", cmd_reset))
    app.add_handler(CommandHandler("briefing", cmd_briefing))
    app.add_handler(CommandHandler("review", cmd_review))
    app.add_handler(MessageHandler(filters.Document.ALL, on_document))
    app.add_handler(MessageHandler(filters.PHOTO, on_photo))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))

    if OWNER_ID:
        jq = app.job_queue
        jq.run_repeating(check_reminders, interval=30, first=5)
        jq.run_daily(briefing_job, time=parse_hhmm(BRIEFING_TIME))
        jq.run_daily(review_job, time=parse_hhmm(REVIEW_TIME), days=(0,))  # 0 = Sunday
        log.info("Jobs scheduled: briefing %s, weekly review Sun %s (%s)", BRIEFING_TIME, REVIEW_TIME, TZ.key)
    else:
        log.warning("OWNER_ID not set: message the bot once to get your ID, then restart.")

    log.info("Second Brain is running. Press Ctrl+C to stop.")
    app.run_polling()


if __name__ == "__main__":
    main()
