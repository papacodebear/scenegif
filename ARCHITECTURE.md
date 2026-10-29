# scenegif — Architecture Plan

A Discord bot that takes a scene description and a caption, finds the matching
moment in a YouTube clip, and returns a captioned GIF.

Target: `/scene "Hercules Fates cutting the thread" "Me picking my fantasy football team"`

---

## 1. Design constraints that shape everything

| Constraint | Consequence |
|---|---|
| Discord interactions must be ACKed in **3 seconds** | Interactions endpoint defers immediately, never does work inline |
| Followups allowed for **15 minutes** after defer | Pipeline has plenty of headroom (~30–60s) |
| Attachment limit **10MB** on unboosted servers | Hard ceiling on output size; drives encode settings |
| GIF autoplays and loops on every client | GIF is the default despite being a bad format |
| Pipeline is CPU/IO heavy, multi-user | Runs in-process behind a concurrency limiter, not a separate worker pool |
| YouTube actively blocks datacenter IPs | Deploy somewhere with a residential IP |

Slash command options give structured input for free. **There is no LLM query
parser** — `scene` and `caption` arrive as separate fields. This removes a whole
stage compared to a CLI entrypoint.

---

## 2. Components

```
┌─ Interactions endpoint (1 replica) ─────────────────────┐
│  /scene handler   → defer, then run pipeline in-process │
│  button handler   → defer, run variant pipeline         │
│  result poster    → edit reply with attachment          │
│                                                          │
│  p-limit(3) gates concurrent pipeline runs:              │
│    1. resolve   query          → video_id               │
│    2. locate    video_id+scene → (t0, t1)  (embedding    │
│                   rank offloaded to a piscina worker)    │
│    3. extract   video_id,t0,t1 → clip.mp4                │
│    4. render    clip+caption   → out.gif                 │
│    5. deliver   upload or CDN link                       │
└──────────────────────────────────────────────────────────┘

In-process Maps — resolve/locate caches, rate limits, button session state
Disk/PV         — clip cache (LRU, size-capped)
```

No Redis, no external store — this is a single process, so plain in-memory
maps cover caching, rate limiting, and session state. The tradeoff: none of it
survives a restart. Acceptable here since a restart just means a cold resolve
cache and any in-flight button sessions expiring early, not silent data loss.

No Gateway/bot-user websocket is needed — slash commands and buttons arrive as
HTTP POSTs. The pipeline runs in the same process behind `p-limit(3)`, which
enforces the global download cap (§6) directly; ffmpeg/yt-dlp are still
subprocesses, so they never block the event loop, and the ACK is sent before
any of this runs — missing the 3-second ACK fails the interaction.

---

## 3. Pipeline stages

### Stage 1 — resolve

Search for the **clip**, not the film. `ytsearch8:"<scene>"` returns 90-second
uploads where the target moment is most of the runtime, which collapses the
localization problem.

Rank results by: YouTube's own result order (strongest signal), stopword-free
title term overlap, duration under ~5 min, view count as a weak tiebreaker.
Reject anything over 20 minutes. All eligible results are kept so the preview
can offer a "wrong video?" picker.

Cache: `hash(normalized_scene)` → ranked video list, TTL 30 days.

### Stage 2 — locate

One `yt-dlp --write-subs --write-auto-subs --write-info-json --skip-download`
call fetches subtitles (uploaded preferred over ASR) plus the info JSON, which
carries duration and the most-replayed heatmap.

YouTube auto-captions **roll**: each cue repeats the previous line, with 10ms
filler cues between. The parser keeps only the newly spoken last line of each
cue and trims cue ends to the word timestamps.

Each cue is a candidate anchor, scored on its own text and with neighbouring
cues as context: MiniLM-L6-v2 similarity (ONNX, in a piscina worker), keyword
overlap, and a small heatmap bonus. The scene is also scored with words from
the video title removed, since "Hercules" identifies the clip, not the moment.
The GIF starts 0.5s before the anchor cue, so the matched line is on screen.

Subtitle text does not need to be accurate — it only needs to localize.

Top heatmap peaks are added as low-scored candidates; with no subs they are the
only candidates, then "start at 15% of runtime" as a last resort. Visual/CLIP
search is **out of scope for v1**.

Cache: `hash(video_id + scene)` → `(t0, t1)`, no expiry.

### Stage 3 — extract

```
yt-dlp -f "bv*[height<=720]" --download-sections "*t0-t1" ...
```

Video-only, no audio muxing. Put `-ss` **before** `-i` in any ffmpeg trim so it
seeks to the keyframe instead of decoding from zero.

Cache: `video_id:t0:t1:height` → path. LRU, size-capped.

### Stage 4 — render

Order matters: **trim → scale → fps → palettegen → paletteuse.** Generating the
palette from the source rather than the trimmed clip is the most common cause
of muddy output.

```
fps=12,scale=480:-1:flags=lanczos,split[a][b];
[a]palettegen=stats_mode=diff[p];
[b][p]paletteuse=dither=bayer:bayer_scale=3
```

Captions: burn an ASS subtitle file, not `drawtext`. ASS gives outlines, word
wrap, and positioning for free; `drawtext` makes you compute all of it.

Budget: 4s by default, up to 60s, under 9.5MB. `hqdn3d` denoise and
`mpdecimate` run before palettegen so grain and duplicate frames don't waste
bytes. If output is over budget, try `gifsicle --lossy` first, then step down
fps → width → colors, then trim duration. Clips over 10s are probed on their
first 10s to pick a starting profile instead of fully encoding at top quality.

**Not cached** — caption varies per request.

### Stage 5 — deliver

Attach directly if under limit. Oversized outputs go to object storage and get
posted as a direct media link.

---

## 4. Cache design (the important part)

Caption is the **last** stage and the most-varied input. Everything before it is
cacheable, so the common Discord pattern — several people riffing on the same
clip — costs exactly one download.

| Stage | Key | Hit rate |
|---|---|---|
| resolve | `hash(scene)` | High |
| locate | `hash(video_id + scene)` | High |
| extract | `video_id:t0:t1:height` | High |
| render | — | Never |

A re-caption of an already-seen scene should return in **under 2 seconds**.
Worth optimizing for explicitly: it's the interaction that makes the bot feel
good.

---

## 5. Command surface

```
/scene <scene> [caption] [duration:1-6] [format:gif|mp4]
```

`scene` is the only required Discord named option; `caption` is optional, presented second in order.

```
/clip <url> [start] [end] [caption]
```

Escape hatch when search picks the wrong video or moment: skips resolve and
locate entirely. `start` defaults to the link's `?t=`, `end` to start + 4s.

Reply **ephemeral** first with buttons. Channel spam from bad cuts is the main
UX failure mode, so the user previews before posting. The preview's text links
the source video at the chosen timestamp and shows which match it is.

```
🎬 Video title (linked to youtu.be/ID?t=123)
2:03 → 2:07 · match 1 of 5 · "matched subtitle text"
[◀ -1s] [+1s ▶] [− shorter] [+ longer]
[⏱ set start…] [📤 post]
[Jump to another match ▾]
[Wrong video? Try another ▾]
```

Buttons are the Discord equivalent of conversational re-cutting. Encode
`(video_id, t0, t1, caption_id)` in `custom_id` so variant jobs skip straight to
stage 3 or 4 — no re-search, no re-download.

The match menu lists up to 10 non-overlapping windows from stage 2, kept in the
session so picking one skips re-ranking. `⏱ set start…` opens a modal for an
exact start time and length. The posted message carries only the GIF and a
source link, with no controls.

---

## 6. Abuse, quota, and blocking

- Per-user rate limit, ~5/min, in-memory token bucket.
- **Global concurrent download cap of 2–3**, enforced with `p-limit(3)` around
  the pipeline call. This is the one that matters — parallel yt-dlp
  invocations are what triggers throttling.
- YouTube bot detection has been aggressive; yt-dlp may require cookies or a PO
  token. Datacenter IPs get blocked far faster than residential ones, so
  self-hosting on home infrastructure is a genuine operational advantage here,
  not just a cost choice.
- Pin the yt-dlp version and expect to bump it. Extractor breakage is routine.
- Surface failures as clean user-facing errors, never stack traces.

---

## 7. Failure modes to handle explicitly

| Case | Behavior |
|---|---|
| No search results | "Couldn't find a clip for that" |
| Video too long (>20 min) | Reject, ask for a more specific scene |
| No subtitles | Heatmap fallback, flag low confidence |
| Low match confidence | Return anyway, note it, let buttons fix it |
| Output over size limit | Auto step-down, then CDN link |
| yt-dlp blocked | Explicit error + log; don't retry hot |

---

## 8. Stack

Node.js. `express` + `discord-interactions` for the interactions endpoint (no
Gateway/bot-user websocket), in-process Maps for caches/rate-limit/session
state (no Redis), `p-limit` to cap concurrent pipelines, `piscina` to run
MiniLM embedding inference off the main thread, `@huggingface/transformers`
(ONNX runtime) for the model itself, `yt-dlp` and `ffmpeg` as subprocesses.

This does not need heavyweight orchestration. The pipeline is five sequential
steps run in-process — a concurrency limiter and idempotent cache keys cover
it, without a separate job queue or worker fleet.

---

## 9. Build order

1. Stages 3+4 standalone — hardcode a video ID and timestamps, get a good-looking
   captioned GIF out. This is where the quality bar actually lives.
2. Stage 2 — subtitle fetch, windowing, embedding rank. Test against known scenes.
3. Stage 1 — search and ranking heuristics.
4. Wire the concurrency limiter, then the Discord layer last.

The bot shell is the easy part. Build it last so it wraps something that already
works.

---

## 10. Open decisions

- **Deployment target** — affects how the clip cache is persisted (PVC vs local
  volume) and whether object storage is needed at all.
- **Object storage** — only required if oversized outputs are common. May be
  avoidable entirely by tightening the encode budget.
- **`mp4` format flag** — worth testing real client behavior before committing;
  the size win is large if it renders acceptably.
- **Guild allowlist** — public bot vs. invite-only changes the abuse surface
  considerably.
