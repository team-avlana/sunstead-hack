# UGC Review Loop — feedback for agency / UGC creators

> **Date:** 2026-06-26 · branch `feat/ugc-review-loop`
> **Status:** Phase 1 (the review contract) implemented. Concept test in progress.

## What this is

A second workflow on the same canvas + analysis spine, aimed at **agencies / UGC
shops** rather than only the solo creator. An agency hands a brief to a roster of
creators, collects the final videos, and wants each delivery checked against its brief:
what landed, what's missing, and a short note to send back.

It's a *widening*, not a teardown — ideation / storyboard / creator-room features stay.
The wedge shifts to the agency loop because (per the Avlana product insights) agencies
already keep footage in the cloud (lowest-friction segment), UGC clips are short so
analysis is near-instant, and the value is a "magical moment before any render": the
diff + the ready-to-send note.

## The loop

```
 BRIEF  ──►  DELIVER  ──►  REVIEW  ──►  COACH
 frame      final video    review       copy-paste
 +ref       analyzed       frame        note
 +hook                     (what's
 +notes                     missing)
```

Every step rides existing primitives:

| Step | Built on |
|---|---|
| Brief | an `artifacts` frame (`role:"brief"`) of text blocks + the reference video block |
| Deliver | a `videos` row + a video block, via the existing `analyze_video` pipeline |
| Review | an `artifacts` frame (`role:"review"`) of text blocks + the delivery video block |
| Coach | a text block ("Send to creator") in the review frame |

## The build (deliberately small)

The "brain" of the review is **the agent reasoning** over data it can already read —
the brief text, the reference analysis, the final analysis — and then building ordinary
frames + text/video blocks. As a result:

- **No scoring backend.** The review is not a service; it's the agent following a rubric.
- **No new database tables.** Brief / delivery / review all live as existing rows
  (`artifacts`, `videos`). No DDL at all for the concept test (see DB safety below).
- **No new tldraw shapes or block types.** Default to `text`; reuse `video` / `image`.

What we actually shipped is a **contract** (rubric + frame layout), encoded as a prompt:

- `src/python-service/review_workflow.py` → `UGC_REVIEW_GUIDE`.
- Injected into the FastMCP `instructions` in `src/python-service/server.py`, so **both**
  the user's own Claude Code *and* the embedded Agent-SDK assistant learn it (the agent
  prompt in `agent_bridge.py` defers to the MCP instructions).
- Mirrored as a Claude Code skill at `.claude/skills/ugc-review/SKILL.md` (operator runbook).

The contract is grounded in fields the analysis pipeline **already** produces:
`metrics.llm.hook_text / hook_format / hook_strength / segments / tone_adjectives /
speaking_style`, `metrics.deterministic.cut_frequency / avg_shot_len`, per-shot
`frame.ocr_text` (on-screen hook match), and `metrics.transcript`.

## Frame conventions

- **Brief** (`role:"brief"`): header (`title-sub`), "Hook (on-screen)", "Notes",
  "Caption", "App footage" text blocks + the reference video block.
- **Review** (`role:"review"`): header (`title-sub`, `VERDICT · score/100`), then one
  `title` block per dimension — Visual hook, Reference, Tone/expression, Pacing,
  Constraints, Missing, Strengths — then the delivery video block, then "Send to
  creator". **Missing** is the load-bearing block (defuses clip-FOMO without a re-watch).

Degrade honestly: when a reference is absent or failed to download, the
reference-dependent blocks say so rather than inventing a comparison; "use this sound"
notes are marked "can't verify" (no audio fingerprinting).

## DB safety (local-only concept test)

- `src/python-service/.env` → `DB_CONNECTION_STRING = localhost:5432/sunstead` (local),
  schema already loaded. **All writes are local; nothing touches the external Aiven DB.**
- The simplification means **zero DDL**, so no migration can reach Aiven by accident.
- Guardrail: keep `.env` pointed at localhost; never run DDL against the Aiven host while
  testing; `src/database/schema.sql` stays canonical.

## Phase 0 status / known blockers

Two issues, both in the analysis worker / ingestion, both independent of the review
contract (which degrades gracefully when a reference is missing or failed):

1. **Worker env gap.** The analysis worker runs under the service venv (`sys.executable`)
   but `faster-whisper` (the transcription stage, in `src/analysis-worker/requirements.txt`)
   is **not installed there** — analysis crashes before completing. Fix: install the
   worker's requirements into the service venv (`faster-whisper` is a large download).
   YouTube downloads fine; this bites at the transcribe stage.
2. **Instagram/Drive ingestion.** The CSV's row-2 reference
   (`instagram.com/reels/DXbpNxeDFZW`) fails at `yt-dlp --dump-json` (exit 1) — IG/TikTok
   often need cookies/login. For a clean demo: supply yt-dlp cookies, or allow direct file
   upload for references.

## Next steps

1. Diagnose the IG/Drive ingestion crash (worker logs) — unblock real references.
2. Run one real review end-to-end against the live brief + a creator's actual video,
   eyeball the note, and tune the rubric wording before encoding anything further.
3. Deferred until the concept proves out: drag-drop CSV import UI, a `talent`
   creator-kind + lightweight per-creator history (can ride `memory.data` jsonb — still
   zero new tables), and a real improvement-over-time chart (the one candidate for a new
   block type).
