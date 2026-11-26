# dsh-plugin-live-meeting

A DeepSeek Harness plugin that listens to any meeting playing through the
default Windows render device, transcribes it locally with SenseVoice, has the
configured DSH model proofread each turn in the meeting's domain and optionally
translate it, keeps a rolling summary, and answers questions from the meeting
with optional web lookup.

Audio never leaves the machine. Only recognized text reaches the model you
already configured in DSH.

## Features

- Native WASAPI loopback capture of the default render endpoint — no virtual
  audio cable, no screen-share picker, no browser media permissions.
- Offline SenseVoice recognition through DSH's optional Voice Input bundle.
- Domain-aware LLM correction (medical, technology, gaming, finance, legal,
  education, manufacturing, marketing, research, custom) using the meeting topic
  and an optional glossary.
- **Local model manager** in settings for SenseVoice (about 240 MB) and CAM++
  speaker embeddings (about 27 MB): status and paths, one-click auto-download,
  official download links on failure, and a local-path import that verifies
  SHA-256 and copies the files into the plugin's `models/` directory (the ASR
  files also go to the DSH speech cache).
- **New / history meeting** buttons in the panel header: New returns to the setup
  flow; History opens the saved meetings and loads one into the panel.
- The header button opens the panel as a tab in DSH's official right sidebar
  (`ctx.sidebarRightTabs` + `ctx.sidebarRight`), so resizing, splitting,
  fullscreen and per-Session persistence are handled by DSH. Older DSH builds
  without those extension services fall back to the built-in floating panel.
- Meeting agenda upload/paste/drag-and-drop (`txt`, `md`, `csv`, `json`), Office
  documents (`PDF`, `Word`, `PPT`, `Excel`, ODF), and images (`png`, `jpg`,
  `webp`, `bmp`): Word/PPT/ODF text is read directly; PDF, legacy Office and
  images are rendered locally with DSH's LibreOffice kit and read with Windows
  OCR. Nothing is parsed on upload: clicking Apply sends the text to the
  configured DSH model, which returns time / speaker / unit / topic columns plus
  the meeting topic and domain (merged rows and OCR noise included). Click the
  agenda bar to pin the current item, and click a speaker chip to reassign that
  turn. Time ranges, speaker names and organizations become the current-item
  indicator, speaker-name suggestions, and reference context for correction,
  minutes and Q&A.
- A durable **my name + role + meeting domain** profile (set in the panel
  settings, stored at `~/.dsh/meetings/profile.json`): it never depends on the
  current meeting or the app session.
- **My speech drafts**: after an agenda upload, only when the user's own name
  appears in the agenda, the model writes the content of the user's own sessions
  — no generic host script, nothing for other speakers. The writing instructions
  are editable and the draft can be regenerated at any time; the Markdown result
  survives page reloads and is stored with the meeting.
- **Cue cards (串词), just in time**: transitions are not written up front. While
  the meeting is being listened to, two minutes before one of the user's moments
  the plugin writes that one card from the structured agenda *and* what has been
  recognized so far. The role decides its shape: a host gets an opening, a
  per-session transition that summarises the speakers of the session that just
  ended (by name, including a panel's participants one by one) and introduces the
  next one, and a closing; a speaker or panelist only gets "thanks for the
  introduction". A card can also be requested from the panel for any agenda item
  (any item for a host).
- **Host drafts**: when the role is host, the draft is not limited to the user's
  own slots — it contains the opening, every per-session transition, and the
  closing, using live transcript and minutes, the meeting context, and the
  structured agenda. Regenerating it during the meeting picks up what was said.
- Local CAM++ voice clustering into 发言人 1/2/3 (about 27 MB): consecutive
  turns by one speaker are merged into one continuous block; a one-minute pass
  re-corrects the whole conversation to join lines split by the 10-second ASR
  window. Labels are suggestions, not identity recognition, and can be renamed
  with an organization. Renaming a speaker can follow the voiceprint: every
  record of that voice is relabeled and same-name identities are merged. A slot
  with several participants is treated as people taking turns — the agenda never
  stamps several names onto one voice.
- Optional microphone capture labelled **自己** (yourself), separate from the
  meeting speakers, with a **microphone switch right before 开始听会** (on by
  default). Echo from the speakers is suppressed: the loopback stream is the
  reference, and a microphone utterance that is only a delayed copy of it is
  dropped before recognition (see *Echo suppression*).
- Per-line translation is **off by default**; English, Simplified Chinese,
  Japanese, or Korean can be enabled per meeting.
- A right-hand sidebar: opening the panel shifts the DSH shell left, and the
  header icon breathes green while listening.
- Raw ASR text kept behind a disclosure, with retry for failed corrections.
- **Editable record**: any recognized turn or line can be deleted while listening
  and after the meeting; speaker chips stay editable on a finished/historical
  meeting; minutes can be regenerated on demand (also after the meeting ended).
- **Minutes as a record of the flow**: on demand, the model writes the meeting
  flow and content in natural paragraphs (what each session and speaker covered,
  what was discussed and agreed) — no fixed "decisions / action items / risks"
  sections, no bullet lists. A final version is written when the meeting ends.
- The agenda box shows the **AI-structured agenda** after a parse (never the raw
  OCR/extracted text), and every generation path (correction, minutes, Q&A,
  drafts, cues) uses the structured agenda entries, not the box text.
- Q&A grounded in the minutes and transcript, with `[mm:ss]` citations and
  optional `ctx.web` search sources.
- On-disk history under `~/.dsh/meetings/<id>/`.

## Echo suppression

The plugin records the default render endpoint (loopback) and the microphone at
the same time. The loopback stream is the reference for the microphone:

1. both streams are reduced to 10 ms RMS→dB envelopes,
2. a microphone VAD segment is correlated against the loopback envelope over a
   0–450 ms delay search,
3. the segment is treated as speaker echo when the envelopes are strongly
   correlated **and** the microphone is not louder than the loopback by more than
   6 dB (louder means the user is talking over it — double-talk, kept),
4. a text-level backstop drops a mic line that repeats a recent loopback line.

Tuning: `DSH_MEETING_AEC=shadow` records the decisions without dropping audio,
`DSH_MEETING_AEC=off` disables the gate. Headphones are still the best remedy;
the gate cannot undo driver-level AEC, Bluetooth nonlinear echo, or a user
speaking far quieter than the speakers.

## My speech drafts (讲词 / 串词)

1. Open settings → **我的信息**, enter **我的姓名** (and optionally the
   organization) and save. The profile is stored on this machine and survives
   restarts.
2. Upload or paste the meeting agenda. If at least one agenda speaker matches
   the saved name, the plugin automatically writes:
   - **我的讲词** — for the agenda slots that belong to the user;
   - **我的串词** — the transitions the user has to say around those slots.
3. Open the **讲词串词** tab to read or regenerate the draft. The textarea in
   **生成提示词** is the writing instruction sent to the model; edit it and press
   **用这个提示词重新生成**. Leave it empty to use the built-in default.

Nothing is generated when no name is saved, or when the saved name does not
appear in the agenda: the draft is for the user only, never a generic script,
and an unmatched name must not spend a model call.

## First open of the day (setup flow)

When there is no meeting record for today yet, opening the panel starts a
three-step setup: name / organization / role, agenda upload (txt, md, csv, json,
PDF, Word, **PPT**, Excel, ODF, screenshots); the pages are rendered to images and handed to the model together with the extracted text, and the model decides whether to read the text, look at the pages, or both) parsed into a
structured agenda (and into the meeting topic, domain and the user's role), then
confirmation in an editable table — start/end time, speaker, organization and
topic can all be changed, rows added or removed. The microphone switch sits right
before **开始听会** and is on by default.

As soon as that is confirmed, a host — or whoever owns the first agenda slot —
gets their first cue card (opening / thanks) immediately, without starting the
meeting. The same structured table is available in the settings panel, and
"重新初始化会议" re-runs the flow.

## Requirements

- Windows 10/11 x64.
- DSH 0.2.1+ with the official **Voice Input** bundle enabled
  (`@deepseek-ai/dsh-experimental-voice-input-bundle`).
- A configured DSH default model and credentials.
- Optional: a configured DSH web-search provider for Q&A lookup.
- The local SenseVoice model (about 240 MB) and, if speaker labels are on, the
  CAM++ speaker-embedding model (about 27 MB) are downloaded on first use.

## Install

```powershell
# from npm
dsh plugin --profile desktop add dsh-plugin-live-meeting
# or from a local checkout
dsh plugin --profile desktop add D:\path\to\dsh-plugin-live-meeting
```

Then enable **Voice Input** and **Meeting Assistant** in DSH's plugin manager.
Open the meeting assistant from the Session header, open settings, and use
**Local model manager** to auto-download SenseVoice (about 240 MB) and, when
speaker labels are enabled, CAM++ (about 27 MB). If auto-download fails, use the
official links and import the local file/directory; the plugin verifies it and
copies it into `models/`.

See [README.zh.md](README.zh.md) for the full Chinese guide, architecture,
privacy notes, and troubleshooting.

## Architecture

```text
system audio -> WASAPI loopback (native helper) -> downmix/resample 16 kHz
  -> energy VAD utterances -> CAM++ speaker embedding + online clustering
  -> SenseVoice (local) -> DSH LLM (domain correction + translation) -> SSE
  -> rolling minutes (LLM) and Q&A (minutes + transcript + optional web search)

microphone -> WASAPI capture -> 16 kHz -> echo gate (loopback envelope
  correlation, double-talk kept) -> labelled 自己

agenda (txt/md/csv/json) -> structured entries -> current time slot,
speaker/org reference, and the only agenda input of every prompt

structured agenda + my-name profile + role -> LLM (editable writing prompt)
  -> Markdown 讲词/串词 (host: opening + per-session transitions + closing)
  -> stored with the meeting, or as a pending draft before it starts
```

The native helper is `native/LoopbackCapture.cs` (C# / .NET Framework 4.x). A
prebuilt `native/LoopbackCapture.exe` ships with the package; rebuild with
`node scripts/build-native.mjs`.

## Development

```powershell
npm run check
npm run selftest
node scripts/build-native.mjs --check
```

`client.js` is loaded as a classic script through DSH's module loader; reload the
page after editing it. Host modules are reloaded by DSH HMR.

## License

MIT
