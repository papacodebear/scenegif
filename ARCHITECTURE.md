# scenegif — Architecture Plan

A Discord bot that takes a scene description and a caption, finds the matching
moment in a YouTube clip, and returns a captioned GIF.

Target: `/scene "Hercules Fates cutting the thread" "Me picking my fantasy football team"`

---

## 1. Design constraints that shape everything

| Constraint | Consequence |
|---|---|
| Discord interactions must be ACKed in **3 seconds** | Gateway process defers immediately, never does work inline |
| Followups allowed for **15 minutes** after defer | Pipeline has plenty of headroom (~30–60s) |
| Attachment limit **10MB** on unboosted servers | Hard ceiling on output size; drives encode settings |
| GIF autoplays and loops on every client | GIF is the default despite being a bad format |
| Pipeline is CPU/IO heavy, multi-user | Needs a real job queue + worker pool |
| YouTube actively blocks datacenter IPs | Deploy somewhere with a residential IP |

Slash command options give structured input for free. **There is no LLM query
parser** — `scene` and `caption` arrive as separate fields. This removes a whole
stage compared to a CLI entrypoint.

---

## 2. Components

```
┌─ Gateway process (1 replica) ──────────────────┐
│  /scene handler  → defer, enqueue, store job   │
│  button handler  → enqueue variant job         │
│  result poster   → edit reply with attachment  │
└────────────────────────────────────────────────┘
                     │ Redis
┌─ Worker pool (2–4 replicas) ───────────────────┐
│  1. resolve   query        → video_id          │
│  2. locate    video_id+scene → (t0, t1)        │
│  3. extract   video_id,t0,t1 → clip.mp4        │
│  4. render    clip+caption → out.gif           │
│  5. deliver   upload or CDN link               │
└────────────────────────────────────────────────┘

Redis   — job state, resolve/locate caches, rate limits
Disk/PV — clip cache (LRU, size-capped)
```

The gateway must never call ffmpeg or yt-dlp. Blocking the Discord heartbeat
drops the connection.

---

## 3. Pipeline stages

### Stage 1 — resolve

Search for the **clip**, not the film. `ytsearch5:"<scene>"` returns 90-second
uploads where the target moment is most of the runtime, which collapses the
localization problem.

Rank results by: duration under ~5 min (strong bonus), title term overlap,
view count as a weak tiebreaker. Reject anything over 20 minutes.

Cache: `hash(normalized_scene)` → `video_id`, TTL 30 days.

### Stage 2 — locate

`yt-dlp --write-auto-sub --sub-format vtt --skip-download` — subtitles only, no
video yet.

Chunk with a **sliding window of 3–5 cues, 50% overlap**. Individual VTT cues
are 1–2s fragments — too short to embed meaningfully and too short to be clip
boundaries. Keep `start` of the first cue and `end` of the last.

Rank with MiniLM-L6-v2 embeddings (ONNX runtime, ~0.5s cold start, no GPU).
Take the best window, expand to a natural boundary, clamp to `duration`.

Subtitle text does not need to be accurate — it only needs to localize.

Fallbacks when no subs exist: most-replayed heatmap from yt-dlp JSON, then
"start at 15% of runtime" as a last resort. Visual/CLIP search is **out of
scope for v1**.

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

Budget: 480px / 12fps / ≤4s lands around 2–5MB. If output exceeds 8MB, step
down fps → width → duration in that order and re-encode.

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

Reply **ephemeral** first with buttons. Channel spam from bad cuts is the main
UX failure mode, so the user previews before posting.

```
[◀ -1s] [+1s ▶] [− shorter] [+ longer] [↻ next match] [📤 post]
```

Buttons are the Discord equivalent of conversational re-cutting. Encode
`(video_id, t0, t1, caption_id)` in `custom_id` so variant jobs skip straight to
stage 3 or 4 — no re-search, no re-download.

`↻ next match` walks down the ranked window list from stage 2, cached.

---

## 6. Abuse, quota, and blocking

- Per-user rate limit, ~5/min, Redis token bucket.
- **Global concurrent download cap of 2–3.** This is the one that matters —
  parallel yt-dlp invocations are what triggers throttling.
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

Python. `discord.py` for the gateway, `arq` for the queue (asyncio-native,
lighter than Celery), Redis, `onnxruntime` + MiniLM for embeddings, `yt-dlp` and
`ffmpeg` as subprocesses.

This does not need heavyweight orchestration. The pipeline is five sequential
steps with retries — a queue and idempotent cache keys cover it.

---

## 9. Build order

1. Stages 3+4 standalone — hardcode a video ID and timestamps, get a good-looking
   captioned GIF out. This is where the quality bar actually lives.
2. Stage 2 — subtitle fetch, windowing, embedding rank. Test against known scenes.
3. Stage 1 — search and ranking heuristics.
4. Wire the queue, then the Discord layer last.

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
