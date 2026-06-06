# Morning Briefing Audio — Operations Handbook

Companion to `container/skills/morning-briefing-audio/SKILL.md` and `docs/nanoclaw-briefing-audio-skill.md`. Covers things that are not committed elsewhere because they are installation-specific or runtime-only: the overlay image rebuild, the schedule rows in the briefing session's `inbound.db`, and the dry-run helper scripts used to verify the credentialed flows end-to-end.

This file is documentation for **this install**. Other forks will have different agent group IDs, image base tags, and session paths.

## Install-specific identifiers (this Pi)

| Thing                       | Value                                                                |
|-----------------------------|----------------------------------------------------------------------|
| Briefing agent group ID     | `ag-1779536804050-zrr42v`                                            |
| Briefing session ID         | `sess-1779536804054-8bbq1j`                                          |
| Group workspace on host     | `data/v2-sessions/ag-1779536804050-zrr42v/sess-1779536804054-8bbq1j/group/` |
| Inbound DB                  | `<workspace parent>/inbound.db`                                       |
| Base image (install slug)   | `nanoclaw-agent-v2-b3e15b0b:latest`                                  |
| Briefing overlay image      | `nanoclaw-agent-v2-b3e15b0b:ag-1779536804050-zrr42v` (base + ffmpeg) |
| OneCLI gateway              | `http://127.0.0.1:10254` (web UI), proxy at `host.docker.internal:10255` |
| OneCLI bridge IP            | `docker inspect onecli --format '{{ index .NetworkSettings.Networks "bridge" "IPAddress" }}'` (typically `172.17.0.2`) |
| TMQ podcast feed (account)  | `https://task-master-quest-production.up.railway.app/podcast/mb-c4296ebca2028e4d.xml` |

## Overlay image — rebuild from scratch

Required because the base image has no ffmpeg; the AUDIO task's concat step and the PUBLISH task's duration probe both need it.

```bash
DF=/tmp/Dockerfile.briefing
cat > "$DF" <<'EOF'
FROM nanoclaw-agent-v2-b3e15b0b:latest
USER root
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
USER node
EOF

cd /home/kpscheffel/nanoclawv2/data
docker build -t nanoclaw-agent-v2-b3e15b0b:ag-1779536804050-zrr42v -f "$DF" .
rm -f "$DF"

# Verify
docker run --rm --entrypoint /bin/sh nanoclaw-agent-v2-b3e15b0b:ag-1779536804050-zrr42v \
  -c 'which ffprobe; ffprobe -version | head -1'
```

The image tag is pinned in `groups/briefing/container.json` under `imageTag`. The host's `container-runner.ts` reads that field at spawn time, so no host restart is needed after a rebuild — the next session spawn picks up the fresh image.

## Scheduled tasks — querying and modifying

The four daily tasks live as `messages_in` rows in the briefing session's `inbound.db`. Each row is `kind='task'` and carries a `recurrence` cron expression. The host sweep auto-inserts the next occurrence when a row completes.

### Inspect current state

```bash
sqlite3 /home/kpscheffel/nanoclawv2/data/v2-sessions/ag-1779536804050-zrr42v/sess-1779536804054-8bbq1j/inbound.db \
  "SELECT id, status, recurrence, process_after, series_id FROM messages_in WHERE kind='task' AND status='pending' ORDER BY process_after;"
```

### Series IDs (stable across recurrences — match by `series_id`, not `id`)

| Series ID                    | Cron (SAST)   | Purpose                                  |
|------------------------------|---------------|------------------------------------------|
| `task-1777068521832-ckb29n`  | `0 6 * * *`   | GATHER — write briefings/YYYY-MM-DD.md   |
| `task-1777068526740-cwz73j`  | `10 6 * * *`  | TRANSMIT — 3x Telegram to telegram-mg-17770 |
| `task-1780228600000-audio01` | `15 6 * * *`  | AUDIO — segmented TTS + ffmpeg concat    |
| `task-1780228600000-publish` | `20 6 * * *`  | PUBLISH — POST to TMQ /api/briefings     |

Cron is interpreted in `TIMEZONE` (Africa/Johannesburg). `process_after` in the DB is UTC.

### Modify a task's prompt or cron

Update both the live pending row AND let recurrence carry it forward. Use a Python transaction so JSON escaping is safe:

```python
import sqlite3, json
DB = "/home/kpscheffel/nanoclawv2/data/v2-sessions/ag-1779536804050-zrr42v/sess-1779536804054-8bbq1j/inbound.db"
con = sqlite3.connect(DB, timeout=10.0)
con.execute("PRAGMA busy_timeout = 10000")
cur = con.cursor()
cur.execute("BEGIN IMMEDIATE")
# Match the live pending row of a series — the next recurrence inherits this row's recurrence
cur.execute(
    "UPDATE messages_in SET recurrence = ?, process_after = ? "
    "WHERE series_id = ? AND status = 'pending'",
    ("15 6 * * *", "2026-06-06T04:15:00.000Z", "task-1780228600000-audio01"),
)
con.commit()
```

To change the prompt only, set `content = json.dumps({"prompt": "...", "script": None})` on the row.

## Audio assets (intro + transition)

The final episode concat interleaves two static MP3 assets that live in the **agent-group folder** (persistent across sessions and container rebuilds):

| Container path | Host path |
|---|---|
| `/workspace/agent/Intro Daily Briefing Mono.mp3` | `groups/briefing/Intro Daily Briefing Mono.mp3` |
| `/workspace/agent/Transition Mono.mp3` | `groups/briefing/Transition Mono.mp3` |

Concat order: `Intro → seg1-international → Transition → seg2-sa → Transition → seg3-tasks`.

Both assets **must** match the TTS output exactly so `ffmpeg -c copy` can concat losslessly:

| Param | Required value |
|---|---|
| Codec | mp3 |
| Sample rate | 24000 Hz |
| Channels | 1 (mono) |
| Bitrate | 128 kbps CBR |

If you replace either asset, re-export from Audacity with **Project Rate = 24000**, mix-down to mono (`Tracks → Mix → Mix Stereo Down to Mono`), then `File → Export → Export as MP3` with `Bit Rate Mode = Constant`, `Quality = 128 kbps`. Verify with `ffprobe -show_streams <file>` before committing. A mismatch shows up as a glitch or pitch shift at the join points, not a loud error.

## Dry-run helpers

Three scripts in this section. Save them next to each other (e.g. `/tmp/`) and run from the host. They reproduce what the scheduled AUDIO + PUBLISH tasks do, end-to-end through the real OneCLI proxy, against the real OpenAI + TMQ credentials. Useful before tweaking the skill, the prompts, or the overlay image.

### `build-envargs.py` — turns OneCLI container-config into docker `-e/-v` flags

```python
import json, sys
cfg = json.load(sys.stdin)
ca_path = "/tmp/onecli-proxy-ca.pem"
open(ca_path, "w").write(cfg["caCertificate"])
sys_ca = open("/etc/ssl/certs/ca-certificates.crt").read().rstrip() + "\n"
open("/tmp/onecli-combined-ca.pem", "w").write(sys_ca + cfg["caCertificate"].rstrip() + "\n")

out = []
for k, v in cfg["env"].items():
    out.append("-e")
    out.append(f"{k}={v}")
out += ["-v", f"{ca_path}:{cfg['caCertificateContainerPath']}:ro"]
out += ["-v", "/tmp/onecli-combined-ca.pem:/tmp/onecli-combined-ca.pem:ro"]
out += ["-e", "SSL_CERT_FILE=/tmp/onecli-combined-ca.pem"]
out += ["-e", "REQUESTS_CA_BUNDLE=/tmp/onecli-combined-ca.pem"]
print("\n".join(out))
```

Usage:

```bash
curl -s "http://127.0.0.1:10254/api/container-config?agent=ag-1779536804050-zrr42v" \
  | python3 /tmp/build-envargs.py > /tmp/briefing-dryrun-envargs.txt
```

### Common docker-run wrapper

```bash
GROUP_DIR=/home/kpscheffel/nanoclawv2/data/v2-sessions/ag-1779536804050-zrr42v/sess-1779536804054-8bbq1j/group
mapfile -t ENVARGS < /tmp/briefing-dryrun-envargs.txt

docker run --rm \
  --add-host "host.docker.internal:172.17.0.2" \
  -v /tmp/<your-script>.py:/tmp/<your-script>.py:ro \
  -v "$GROUP_DIR:/workspace/group" \
  "${ENVARGS[@]}" \
  --entrypoint python3 \
  nanoclaw-agent-v2-b3e15b0b:ag-1779536804050-zrr42v \
  /tmp/<your-script>.py
```

`--add-host host.docker.internal:172.17.0.2` bypasses the rootless-Docker port-forward flake; the IP comes from inspecting the `onecli` container's bridge address (verify with the command in the identifiers table above).

### `briefing-full-dryrun.py` — full pipeline (TTS x3 + concat + ffprobe + TMQ POST)

Set `DRYRUN_DATE=YYYY-MM-DD` (defaults to `2026-05-29`) for the source briefing. Set `DRYRUN_FEED_SLUG=morning-briefing` to publish to the real feed; defaults to `morning-briefing-dryrun` (which resolves to the same Apple Podcasts feed because TMQ keys the obscure slug to the account, not the slug — but the row gets a sandbox feed_slug value). Set `DRYRUN_PUBLISH=0` to skip the TMQ call.

```python
#!/usr/bin/env python3
"""Full-pipeline dry-run of the morning-briefing-audio + publish chain."""
from __future__ import annotations

import datetime as dt
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid


SECTION_LEADS = [
    (re.compile(r"^##\s+Weather\s+[—-]\s+Johannesburg\s*$", re.M), "\n\nWeather for Johannesburg.\n\n"),
    (re.compile(r"^##\s+International\s*$",                    re.M), "\n\nInternational news.\n\n"),
    (re.compile(r"^##\s+South Africa\b.*$",                    re.M), "\n\nSouth Africa headlines.\n\n"),
    (re.compile(r"^##\s+Your Tasks for Today\s*$",             re.M), "\n\nYour tasks for today.\n\n"),
]

ABBREVIATIONS = [
    (re.compile(r"\bR\s+(\d)"),                   r"\1"),
    (re.compile(r"\bUSD/ZAR\b"),                   "the dollar to rand exchange rate"),
    (re.compile(r"\bSARB\b"),                      "S A R B"),
    (re.compile(r"\bVFS\b"),                       "V F S"),
    (re.compile(r"\bSpaceX\b"),                    "Space X"),
    (re.compile(r"\bOpenAI\b"),                    "Open A I"),
    (re.compile(r"\bxAI\b"),                       "x A I"),
    (re.compile(r"(?<![A-Za-z])AI(?![A-Za-z])"),   "A I"),
    (re.compile(r"(?<![A-Za-z])SA(?![A-Za-z])"),   "South Africa"),
    (re.compile(r"\bURL\b"),                       "U R L"),
    (re.compile(r"°C"),                            " degrees Celsius"),
    (re.compile(r"\bkm/h\b"),                      " kilometres per hour"),
    (re.compile(r"%"),                             " percent"),
]


def clean(segment: str) -> str:
    s = segment
    s = re.sub(r"^_Report generated by NanoClaw_.*$", "", s, flags=re.M)
    s = re.sub(r"^#\s+Morning Briefing[^\n]*\n", "", s, count=1)
    for pat, repl in SECTION_LEADS:
        s = pat.sub(repl, s)
    s = re.sub(r"^---+\s*$", "", s, flags=re.M)
    if "```" in s:
        s = re.sub(r"```.*?```", "Code block omitted from audio.", s, flags=re.S)
    if re.search(r"^\s*\|", s, flags=re.M):
        out, in_tbl, replaced = [], False, False
        for ln in s.splitlines():
            if ln.lstrip().startswith("|"):
                if not in_tbl:
                    in_tbl = True
                    if not replaced:
                        out.append("A table is shown in the written report.")
                        replaced = True
                continue
            in_tbl = False
            out.append(ln)
        s = "\n".join(out)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", s)
    s = re.sub(r"^\s*\(?https?://\S+\)?\s*$", "", s, flags=re.M)
    s = re.sub(r"[*_`~#]", "", s)
    new_lines = []
    for ln in s.split("\n"):
        m = re.match(r"^\s*[-*•]\s+(.*)$", ln)
        if m:
            body = m.group(1).rstrip()
            if not body.endswith((".", "!", "?")):
                body += "."
            new_lines.append(body)
        else:
            new_lines.append(ln)
    s = "\n".join(new_lines)
    for pat, repl in ABBREVIATIONS:
        s = pat.sub(repl, s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def split_segments(md: str) -> tuple[str, str, str]:
    h_weather = re.search(r"^##\s+Weather\s+[—-]\s+Johannesburg\s*$", md, re.M)
    h_sa      = re.search(r"^##\s+South Africa\b.*$",                  md, re.M)
    h_tasks   = re.search(r"^##\s+Your Tasks for Today\s*$",           md, re.M)
    if not all([h_weather, h_sa, h_tasks]):
        raise RuntimeError("missing one of: weather, south africa, tasks heading")
    seg_intl  = md[h_weather.start():h_sa.start()]
    seg_sa    = md[h_sa.start():h_tasks.start()]
    seg_tasks = md[h_tasks.start():]
    return seg_intl, seg_sa, seg_tasks


INSTRUCTIONS = (
    "Voice Affect: Calm, composed, professional. Project quiet authority without sounding stern.\n\n"
    "Tone: Like a morning news anchor on a quality public broadcaster. Measured. Trustworthy. Not theatrical.\n\n"
    "Pacing: Steady and unhurried. Slight natural pauses between stories and at section transitions. Do not rush.\n\n"
    "Emotion: Neutral and informative. Slightly warmer for opening greetings and closings. Matter-of-fact for news content. Light touch only — no dramatic emphasis.\n\n"
    "Pronunciation: Clear articulation. Treat acronyms read as letters as letter-by-letter (S A R B, V F S). Pronounce place names carefully."
)


def tts(script: str, out_path: pathlib.Path) -> int:
    body = {
        "model": "gpt-4o-mini-tts",
        "voice": "sage",
        "input": script,
        "instructions": INSTRUCTIONS,
        "response_format": "mp3",
        "speed": 1.0,
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/audio/speech",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},  # NO Authorization — OneCLI injects
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    out_path.write_bytes(data)
    return len(data)


def ffmpeg_concat(parts: list[pathlib.Path], out: pathlib.Path) -> None:
    list_path = pathlib.Path("/tmp/concat-list.txt")
    list_path.write_text("\n".join(f"file '{p}'" for p in parts) + "\n")
    subprocess.check_call(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-f", "concat", "-safe", "0", "-i", str(list_path),
         "-c", "copy", str(out)],
        timeout=60,
    )


def ffprobe_duration(p: pathlib.Path) -> int | None:
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(p)],
            text=True, timeout=20,
        ).strip()
        return round(float(out))
    except Exception as e:
        print(f"ffprobe failed: {e}", file=sys.stderr)
        return None


def post_to_tmq(mp3: pathlib.Path, transcript: str, *, date_str: str,
                title: str, description: str, duration_s: int | None,
                feed_slug: str) -> tuple[int, str]:
    boundary = "----nanoclaw-" + uuid.uuid4().hex
    crlf = b"\r\n"
    buf = io.BytesIO()

    def text_field(name, value):
        buf.write(f"--{boundary}".encode() + crlf)
        buf.write(f'Content-Disposition: form-data; name="{name}"'.encode() + crlf + crlf)
        buf.write(value.encode("utf-8") + crlf)

    def file_field(name, filename, content, ctype):
        buf.write(f"--{boundary}".encode() + crlf)
        buf.write(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"'.encode() + crlf)
        buf.write(f"Content-Type: {ctype}".encode() + crlf + crlf)
        buf.write(content + crlf)

    text_field("feed_slug", feed_slug)
    text_field("date", date_str)
    text_field("title", title)
    text_field("description", description)
    text_field("transcript", transcript)
    if duration_s is not None:
        text_field("audio_duration", str(duration_s))
    file_field("audio", mp3.name, mp3.read_bytes(), "audio/mpeg")
    buf.write(f"--{boundary}--".encode() + crlf)
    body_bytes = buf.getvalue()

    req = urllib.request.Request(
        "https://task-master-quest-production.up.railway.app/api/briefings",
        data=body_bytes,
        headers={
            # NO Authorization — OneCLI injects for this host
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body_bytes)),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def first_sentence(s: str) -> str:
    m = re.match(r"(.+?[.!?])(?:\s|$)", s.strip())
    return m.group(1) if m else s.strip()[:120]


def main() -> int:
    date_str = os.environ.get("DRYRUN_DATE", "2026-05-29")
    publish_enabled = os.environ.get("DRYRUN_PUBLISH", "1") != "0"
    feed_slug = os.environ.get("DRYRUN_FEED_SLUG", "morning-briefing-dryrun")

    src = pathlib.Path(f"/workspace/group/briefings/{date_str}.md")
    if not src.exists():
        print(f"source missing: {src}", file=sys.stderr)
        return 2

    out_dir = pathlib.Path("/workspace/group/audio")
    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = f"dryrun-{date_str}"
    seg_paths = [
        out_dir / f"{prefix}-01-international.mp3",
        out_dir / f"{prefix}-02-sa.mp3",
        out_dir / f"{prefix}-03-tasks.mp3",
    ]
    intro_mp3 = pathlib.Path("/workspace/agent/Intro Daily Briefing Mono.mp3")
    transition_mp3 = pathlib.Path("/workspace/agent/Transition Mono.mp3")
    for asset in (intro_mp3, transition_mp3):
        if not asset.exists():
            print(f"asset missing: {asset}", file=sys.stderr)
            return 2
    final_mp3 = out_dir / f"{prefix}.mp3"
    final_txt = out_dir / f"{prefix}.txt"

    md = src.read_text()
    d = dt.date.fromisoformat(date_str)
    weekday, weekday_short = d.strftime("%A"), d.strftime("%a")
    month, month_short = d.strftime("%B"), d.strftime("%b")

    raw_intl, raw_sa, raw_tasks = split_segments(md)
    seg1, seg2, seg3 = clean(raw_intl), clean(raw_sa), clean(raw_tasks)
    intro = f"Good morning, Peter. This is your briefing for {weekday}, {d.day} {month} {d.year}."
    outro = "That is the end of your briefing. Have a good day."
    seg1 = f"{intro}\n\n{seg1}"
    seg3 = f"{seg3}\n\n{outro}"

    chars = [len(seg1), len(seg2), len(seg3)]
    print(f"segment chars: international={chars[0]}  sa={chars[1]}  tasks={chars[2]}")
    if any(n > 4096 for n in chars):
        print(f"WARN: segments over 4096: {[i for i, n in enumerate(chars) if n > 4096]}", file=sys.stderr)

    full_script = f"{seg1}\n\n{seg2}\n\n{seg3}\n"
    final_txt.write_text(full_script)

    t0 = time.monotonic()
    for i, (seg, p) in enumerate(zip([seg1, seg2, seg3], seg_paths), start=1):
        ts = time.monotonic()
        try:
            n = tts(seg, p)
        except urllib.error.HTTPError as e:
            print(f"OpenAI HTTP {e.code} on segment {i}: {e.read().decode(errors='replace')[:500]}", file=sys.stderr)
            return 3
        print(f"  segment {i}: {n} bytes ({int((time.monotonic()-ts)*1000)} ms)  →  {p.name}")

    concat_parts = [
        intro_mp3,
        seg_paths[0],
        transition_mp3,
        seg_paths[1],
        transition_mp3,
        seg_paths[2],
    ]
    try:
        ffmpeg_concat(concat_parts, final_mp3)
    except subprocess.CalledProcessError as e:
        print(f"ffmpeg concat failed: {e}", file=sys.stderr)
        return 4

    final_size = final_mp3.stat().st_size
    duration = ffprobe_duration(final_mp3)
    if duration is not None:
        (out_dir / f"{prefix}.duration").write_text(str(duration))
    print(f"concat: {final_size} bytes  duration: {duration}s")

    if not publish_enabled:
        print("DRYRUN_PUBLISH=0 — skipping TMQ POST")
        return 0

    title = f"Morning Briefing — {weekday_short}, {d.day} {month_short} {d.year}"
    desc_parts = [first_sentence(seg1.split('\n\n', 1)[1] if '\n\n' in seg1 else seg1),
                  first_sentence(seg2.split('\n\n', 1)[1] if '\n\n' in seg2 else seg2)]
    description = " | ".join(desc_parts)[:250]

    print(f"posting to TMQ: feed_slug={feed_slug}  title={title!r}")
    status, body = post_to_tmq(
        final_mp3, full_script,
        date_str=date_str, title=title, description=description,
        duration_s=duration, feed_slug=feed_slug,
    )
    print(f"TMQ HTTP {status}\n{body[:2000]}")
    return 0 if status == 200 else 5


if __name__ == "__main__":
    sys.exit(main())
```

### `briefing-publish-only.py` — POST an already-built MP3 to TMQ

For when TTS already produced today's MP3 but publish needs to be re-run (e.g. TMQ was down). Reads `audio/dryrun-<DATE>.mp3` / `.txt` / `.duration` and POSTs.

```python
#!/usr/bin/env python3
"""Publish an already-generated dry-run MP3 to TMQ's real feed_slug."""
from __future__ import annotations

import datetime as dt
import io
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
import uuid

DATE = os.environ.get("DRYRUN_DATE", "2026-05-29")
FEED_SLUG = os.environ.get("DRYRUN_FEED_SLUG", "morning-briefing")

audio_dir = pathlib.Path("/workspace/group/audio")
mp3 = audio_dir / f"dryrun-{DATE}.mp3"
txt = audio_dir / f"dryrun-{DATE}.txt"
dur_file = audio_dir / f"dryrun-{DATE}.duration"

if not mp3.exists() or not txt.exists():
    print(f"missing {mp3} or {txt}", file=sys.stderr)
    sys.exit(2)

transcript = txt.read_text()
duration = int(dur_file.read_text().strip()) if dur_file.exists() else None

d = dt.date.fromisoformat(DATE)
title = f"Morning Briefing — {d.strftime('%a')}, {d.day} {d.strftime('%b')} {d.year}"
description = f"Briefing for {d.strftime('%A')}, {d.day} {d.strftime('%B')} {d.year}."

boundary = "----nanoclaw-" + uuid.uuid4().hex
crlf = b"\r\n"
buf = io.BytesIO()

def text_field(n, v):
    buf.write(f"--{boundary}".encode() + crlf)
    buf.write(f'Content-Disposition: form-data; name="{n}"'.encode() + crlf + crlf)
    buf.write(v.encode("utf-8") + crlf)

def file_field(n, fn, c, ct):
    buf.write(f"--{boundary}".encode() + crlf)
    buf.write(f'Content-Disposition: form-data; name="{n}"; filename="{fn}"'.encode() + crlf)
    buf.write(f"Content-Type: {ct}".encode() + crlf + crlf)
    buf.write(c + crlf)

text_field("feed_slug", FEED_SLUG)
text_field("date", DATE)
text_field("title", title)
text_field("description", description)
text_field("transcript", transcript)
if duration is not None:
    text_field("audio_duration", str(duration))
file_field("audio", f"{DATE}.mp3", mp3.read_bytes(), "audio/mpeg")
buf.write(f"--{boundary}--".encode() + crlf)
body_bytes = buf.getvalue()

req = urllib.request.Request(
    "https://task-master-quest-production.up.railway.app/api/briefings",
    data=body_bytes,
    headers={
        # NO Authorization — OneCLI injects for this host
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(body_bytes)),
    },
    method="POST",
)

print(f"posting to TMQ: feed_slug={FEED_SLUG}  title={title!r}")
t0 = time.monotonic()
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        status, body = r.status, r.read().decode("utf-8", errors="replace")
except urllib.error.HTTPError as e:
    status, body = e.code, e.read().decode("utf-8", errors="replace")
print(f"TMQ HTTP {status} ({int((time.monotonic()-t0)*1000)} ms)\n{body[:2000]}")
sys.exit(0 if status == 200 else 3)
```

## Verify a daily run worked

Once a scheduled run has fired (after 06:20 SAST on any given day), check on the host:

```bash
WORKSPACE=/home/kpscheffel/nanoclawv2/data/v2-sessions/ag-1779536804050-zrr42v/sess-1779536804054-8bbq1j/group
DATE=$(date +%Y-%m-%d)

ls -la "$WORKSPACE/briefings/$DATE.md"        # gather output
ls -la "$WORKSPACE/audio/$DATE".{mp3,txt,duration}  # audio output
cat    "$WORKSPACE/audio/$DATE.duration"      # rounded seconds

# Pending tasks for tomorrow
sqlite3 "$(dirname "$WORKSPACE")/inbound.db" \
  "SELECT id, status, recurrence, process_after FROM messages_in WHERE kind='task' AND status='pending' ORDER BY process_after;"

# Last 24h failures
sqlite3 "$(dirname "$WORKSPACE")/inbound.db" \
  "SELECT id, kind, status, process_after, substr(content, 1, 80) FROM messages_in WHERE status='failed' AND process_after > datetime('now','-1 day') ORDER BY process_after DESC;"

# Confirm episode landed in TMQ (no auth — public feed XML)
curl -s "https://task-master-quest-production.up.railway.app/podcast/mb-c4296ebca2028e4d.xml" \
  | grep -A 2 "<item>" | head -20
```

## Common failure modes

- **HTTP 401 from OpenAI** — agent (or your script) sent its own `Authorization` header. OneCLI inject requires the header to be **absent** so the proxy can add it. Re-read [[reference_onecli_inject_secrets]].
- **HTTP 401 from TMQ** — same root cause as OpenAI; or the OneCLI agent for `ag-1779536804050-zrr42v` has been flipped out of `secretMode: all`. Verify with `onecli agents list`.
- **`Connection refused` on the proxy** — `host.docker.internal` is mapping to a stale IP. Re-inspect `onecli`'s bridge IP and re-pass it via `--add-host`.
- **`ffprobe: command not found`** — overlay image is stale or the container is using the base image. Check `groups/briefing/container.json` `imageTag`, rebuild per the section above.
- **Source markdown missing** — GATHER failed earlier. Check the `messages_in` row for the GATHER task — its `status` and any recent `failed` rows from that series.
- **Audio is silent / mispronounced** — the SKILL.md abbreviation dictionary is the right place to extend; consistency matters more than completeness. Tune one entry per day and re-run a publish-only dry-run to verify.
