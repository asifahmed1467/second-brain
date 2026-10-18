# Second Brain: your personal study companion

A private assistant that only you can use, with an animated companion that lives in a night sky. **Every fact you teach it becomes a star in its sky**, and it levels up as you train it.

You can use it two ways, both sharing the same memory:

- **Phone app** (`app.py`): install it on your home screen like a normal app
- **Telegram bot** (`second_brain_bot.py`): optional, chat with it inside Telegram

## What it does
- **Learns from chat (training):** switch to *Teach* and type facts, rules, room numbers, or paste a whole FAQ. Tap **Correct this** under any wrong answer and it fixes it forever.
- **Knows you:** your name, university, courses and goals (`profile.txt` and the Me tab)
- **Remembers your notes:** PDFs, .txt files, and photos of your notebook
- **Teaches and quizzes you** from what you taught it and your notes
- **Reminders and expenses** in plain language
- **Voice:** tap the mic to talk, tap the speaker to hear replies (English or Bangla)
- **Morning briefing** (sun button) and a **weekly review**

### The animated companion
It reacts to what you do: it floats and blinks while idle, shows sound rings while you use the mic, looks up with orbiting sparks while thinking, moves its mouth while reading aloud, and glows and hops when it learns, as a star flies up into the sky. When it reaches a new level, the sky flashes.

## Files
```
second-brain/
├── brain.py              the shared brain: memory, learning, Claude, voice
├── app.py                the phone app server
├── second_brain_bot.py   the Telegram bot (optional)
├── static/               the app's screens, icon and install files
├── profile.txt           facts about you
├── requirements.txt
└── .env.example          your settings (copy to .env)
```

## Setup (about 15 minutes)

### 1. Get a Claude API key
Go to https://console.anthropic.com, sign up, add a little credit, then create a key under **API Keys**.

### 2. Install
You need Python 3.10 or newer.
```bash
cd second-brain
python -m venv venv
# Windows:  venv\Scripts\activate
# Mac/Linux: source venv/bin/activate
pip install -r requirements.txt
```
Copy `.env.example` to `.env`. Fill in `ANTHROPIC_API_KEY` and choose an `APP_PASSWORD`.
Fill in the `[fill in]` lines of `profile.txt`.

### 3. Run the app
```bash
python app.py
```
It prints two addresses. On your computer open `http://localhost:8000`.

### 4. Put it on your phone
1. Connect your phone to the **same Wi-Fi** as your computer.
2. Open the second address it printed (like `http://192.168.0.105:8000`) in Chrome on your phone.
3. Enter your app password once.
4. Chrome menu (⋮) → **Add to Home screen**. You now have a Second Brain icon that opens full screen.

On iPhone use Safari → Share → **Add to Home Screen**.

> If your phone can't open the address, allow Python through your computer's firewall when Windows asks, or turn off "AP isolation" on the router.

## Train it by chatting
| Where | What you do |
|---|---|
| Chat, *Teach* mode | "The CSE office is in Annex 4, room 402" → learned, new star |
| Under any answer | **Correct this** → "Correction: the deadline is 2 November" → it replaces the old answer |
| Teach tab | Paste a block of text (a notice, an FAQ) → it learns each idea separately |
| Teach tab list | See everything it learned; tap ✕ to make it forget |
| Normal chat | "Learn this: ..." or "That's wrong, ..." also works |
| Telegram | `/teach <fact>` and `/brain` |

**How the training works:** taught facts are stored in your own database (`brain.db`). Before every reply, the most relevant ones are given to Claude with the instruction to trust them over its general knowledge. The model itself isn't retrained; this method is instant, free, editable, and works on day one.

## Use it anywhere (not only on home Wi-Fi)
Host it online so it gets an `https://` address:
1. Put the folder on GitHub (keep `.env` private; it's your keys).
2. Create a free web service on **Render** or **Railway** from that repo.
3. Start command: `uvicorn app:app --host 0.0.0.0 --port $PORT`
4. Add your `.env` values as environment variables there.

With HTTPS you also get proper app install and reminder notifications.
Note: free hosts may wipe files on redeploy. Attach a persistent disk and set `DB_PATH=/data/brain.db` to keep your memory safe.

### Want a real Android APK?
Once it's online with HTTPS, open https://www.pwabuilder.com, paste your app's address, and download an Android package you can install or publish to the Play Store.

## Optional: the Telegram bot
1. Message **@BotFather** on Telegram, send `/newbot`, copy the token into `TELEGRAM_TOKEN` in `.env`.
2. Run `python second_brain_bot.py`, message your bot `/start`, put the ID it replies with into `OWNER_ID`, restart.

You can run the app and the bot at the same time; they share the same memory.

## Good to know
- Reminders and briefings in the **app** pop up while it's open. For alerts when it's closed, also run the Telegram bot, which messages you at the right time.
- Your data lives in `brain.db`. Back it up now and then.
- Set a monthly spending limit in the Anthropic console. Haiku (the default) is very cheap for one person; switch `CLAUDE_MODEL` to Sonnet for deeper explanations.
- Bangla voice replies: set `TTS_VOICE=bn-BD-NabanitaNeural`. Bangla voice typing: Me tab → Mic language.
