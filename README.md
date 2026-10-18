# Second Brain

A free personal study companion for your phone. A little animated friend lives in a night sky: **every fact you teach it becomes a star**, and it levels up as you train it.

**Costs nothing.** It runs on Google Gemini's free tier with your own key (no card), is hosted free on GitHub Pages, and keeps all your data on your phone.

## What it does
- **Learns from chat:** switch to *Teach* and type facts, rules, room numbers, or paste a whole notice. Tap **Correct this** under a wrong answer and it fixes it for good.
- **Knows you:** your name, university, courses and goals
- **Reads your notes:** PDFs, text files and photos of your notebook (handwriting too)
- **Teaches and quizzes you** from what you taught it and your notes
- **Reminders and expenses** in plain language ("Spent 120 on lunch")
- **Voice:** mic to talk, speaker to hear replies, in English or Bangla
- **Morning briefing** (sun button) and **weekly review**
- **Backup and restore** of everything

## Where things live
```
docs/      the phone app (this is what GitHub Pages publishes)
server/    an optional older version that uses the paid Claude API (not needed)
```

## Step A: get a free Gemini key
1. Go to **aistudio.google.com/apikey** and sign in with your Google account.
2. Click **Create API key** and copy it (it starts with `AIza`).
3. Keep it private. Never put it in this repository. You'll paste it into the app on your phone, and it stays only there.

## Step B: publish the app with GitHub Pages
1. In this repository, open **Settings → Pages**.
2. Under **Build and deployment**, set Source to **Deploy from a branch**.
3. Choose branch **main** and folder **/docs**, then click **Save**.
4. Wait 1 to 2 minutes and refresh. The page shows your address:
   `https://asifahmed1467.github.io/second-brain/`

GitHub Pages is free for public repositories, so keep this one public. Nothing private is stored in it.

## Step C: open it on your phone
Open the address in **Chrome** on your phone, enter your name and the Gemini key, and start chatting. To install without an APK: Chrome menu (⋮) → **Add to Home screen**.

## Step D: build the APK
1. Go to **pwabuilder.com** and paste your address.
2. Click **Package for stores**, then **Android**, then **Generate Package**.
3. Download the zip and unzip it. Inside is an `.apk` file.
4. Send the `.apk` to your phone, open it, and allow "install unknown apps" when Android asks.

## Good to know
- **Your data is on your phone.** Use **Me → Back up my brain** now and then. Uninstalling the app or clearing Chrome's data erases it, and the backup lets you restore it.
- **Free limit:** if Google says you've hit the free limit, wait a minute or switch the model to `gemini-2.5-flash-lite` in **Me → Settings**.
- **Privacy:** on Gemini's free plan Google may use your messages to improve its products. Don't send passwords or very private details.
- **Reminders** pop up while the app is open.
- **Bangla voice:** the phone reads Bangla aloud if its text-to-speech has Bangla installed (Settings → Google text-to-speech → Install voice data → Bangla).
