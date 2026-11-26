# Voice input

Dictate into the composer, citation comments, diff/file annotations, PR comments, and desktop browser annotations. Transcripts land in your draft for review—nothing is sent to an agent until you submit.

## Choose where audio goes

- **Web and desktop**: Nothing is recorded or sent until you choose a destination in **Settings → Voice → Transcribe with**:
  - **On this Mac (Apple Speech)** (macOS 26+ desktop): Transcribes locally on your Mac (silence filtering and filler removal unavailable; dictionary applies only with cleanup enabled).
  - **A connected environment**: Sends audio over your authenticated connection to transcribe locally on that host and discards the audio. Never silently fails over to another host.
  - **Cloud providers (OpenAI, Grok Voice Transcribe, OpenRouter)**: Configure an API key (or [secret reference](./secrets.md)) on an environment to forward recordings to that provider. OpenRouter lets each user pick a model from its live STT catalog and requests zero data retention.
- **Mobile (iOS and Android)**: Transcribes on-device by default (iOS 26+ or Android 12+ with compatible Google speech services; first use may download a speech model, then works offline). To transcribe on a paired environment or cloud provider instead, configure **Settings → Voice → Transcribe on**. Keep T3 Code open while dictating on Android. OpenAI's GPT Transcribe and Microsoft's MAI-Transcribe-2 upload straight from the phone with a key from **Settings → Voice → API keys** (OpenAI is the default once its key is stored). Keys stay in the device's secure storage. MAI services take Azure Speech keys from West US 2 resources; add a free F0 key, a paid S0 key, or both, and T3 Code uses F0 until its monthly quota runs out.

## Set up a local transcription model

In **Settings → Voice → Transcription**, filter by language, download a model, and select **Use model** (reuses matching files from Handy or the Hugging Face cache, or link an existing file via **Use existing**—Core ML/ONNX/MLX builds aren't supported).

- **Advanced**: Configure GPU/CPU (**Auto** falls back to CPU once on GPU error), idle unload timeout, and **Streaming transcription** (disable if live preview lags).

## Dictate and shortcuts

- Press the microphone button or `mod+shift+d` to start/stop (`Esc` discards; max recording length: **5 minutes**).
- Configure tap vs. hold behavior in **Settings → Voice → Dictation shortcut** (**Auto**, **Hold**, or **Toggle**), or remap the chord in [Keybindings](./keybindings.md).
- Pressing **Send** (or Save/Comment/Submit) while recording finishes transcription and submits automatically.

## Dictate on mobile

- Record, then confirm to insert text where your selection was. The send button beside the check mark transcribes and sends at once; a tone confirms, and the reply is read aloud while you stay in the thread; the send button shows a speaker when it will be. Set **Read voice replies** in **Settings → Voice** to **Never**, or **On selected devices** to read only while a device with **Read aloud** on is connected, such as your car. Approvals, questions, and failures are announced; enable **Read thinking updates** to hear progress messages too.
- Recordings last up to 5 minutes, or 20 with a cloud service. On iPhone they continue with the phone locked; a call, Siri, or an alarm ends the recording with a tone and adds what was captured without sending.
- Failed transcriptions keep the recording so you can retry. Canceling discards it and keeps your draft. Dictation continues on other screens; use the floating controls to finish or cancel.
- iPhone dictates in your first preferred language that Apple's speech model supports, else the app's language.
- Dictated messages end with a short note so the agent expects misheard words.

## Read responses aloud

- Tap the speaker under a response to read it; tap again to stop. The bar above the composer rewinds 10 seconds, pauses, skips a paragraph, changes pace, and stops; headphone, car, Lock Screen, and Android notification controls do the same. Tap a paragraph to read from there. Code blocks are announced, not read. Removing headphones pauses.
- In **Settings → Voice → Read aloud**, pick the model (MAI-Voice-2.1 Flash by default, MAI-Voice-2.1, Gemini Flash or Flash-Lite, or ElevenLabs v4 or v4 Turbo), voice, and pace; Gemini also takes a **Delivery** description. Reading costs about 1–7 cents per minute. Use a paid-tier Gemini key: Google trains on free-tier requests. On Android, reading can only start while T3 Code is open.

## Improve recognition and cleanup

- **Language & translation**: Pick a language or **Auto** (plus **Translate to English** where supported).
- **Personal & project dictionaries**: Add custom terms and common misspelling aliases in **Settings → Voice** (device-level) or scoped to a project/environment (up to 100 combined entries; project entries take priority).
- **Silence filtering & filler removal**: Skip silence (on by default) and strip hesitation words.
- **Transcript cleanup** (off by default): Sends the finished transcript and surrounding draft text (never audio) to your [text generation model](./text-generation.md) (or a dedicated **Cleanup model**) to fix punctuation, numbers, and spoken self-corrections (optionally using a custom **Correction cue** like "scratch that"). Press **Skip** during cleanup to insert raw text.

## Microphones and testing

- **Microphone priority**: Rank built-in, wired, Bluetooth, and CarPlay (iOS) devices in **Settings → Voice**—T3 Code uses the first connected device in the list. Bluetooth devices appear by name once connected, and wired ones once you've dictated with them, so you can rank them against kinds (e.g. **Other Bluetooth** above your AirPods); swipe left to forget one.
- **Test**: Use **Test microphone** (local 10-second loopback, no transcription) to verify input, and **Test model** to preview raw transcription without cleanup.
- Browser recording requires **HTTPS** or `localhost`—for plain-HTTP remote servers, use the desktop app.
