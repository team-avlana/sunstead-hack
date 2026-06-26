"""UGC review loop — agent-facing workflow guide.

A second workflow for this service, aimed at agencies / UGC shops (not only the
solo creator). An agency hands a brief to a roster of creators, collects the
final videos, and wants each delivery checked against its brief: what landed,
what's missing, and a short note to send back to the creator.

The "brain" of the review is the AGENT reasoning over data it can already read —
the brief text, the reference video's analysis, and the final video's analysis —
and then building ordinary frames + text/video blocks. There is no scoring
service and no new database table or shape: a brief is an `artifacts` frame, a
delivery is a `videos` row + a video block, a review is a frame of text blocks.

This string is injected into the MCP server `instructions` (server.py) so both
the user's own Claude client and the embedded Agent SDK assistant learn it. Keep
the rubric/layout here in sync with the block vocabulary in block_normalize.py
(BLOCK_TAXONOMY_GUIDE) — reviews are built from those same blocks.
"""

from __future__ import annotations

UGC_REVIEW_GUIDE = """\
UGC REVIEW LOOP — feedback for agency / UGC creators

A second mode of this app, for agencies and UGC shops. The agency writes briefs,
hires creators to shoot them, collects the final videos, and needs each delivery
checked against its brief: what landed, what's missing, a note to send back. Use
this mode when the user talks about briefs, creators/roster, deliveries, reviewing
or comparing a creator's video against instructions, or imports a brief sheet (CSV).

You are the brain of the review. You read the brief, the reference video's analysis,
and the final video's analysis, then reason and build ordinary frames + text/video
blocks. No new block types: everything is text, video, image inside a frame. Default
to text. Follow the WRITING STYLE rules for every word you put on the canvas.

THE LOOP:  Brief  ->  Deliver  ->  Review  ->  Coach

## 1. BRIEF  (a frame, payload.role = "brief")
One brief = one frame. Build it from text blocks plus the reference video. Layout
the blocks in a single column (x ~24, increasing y); the canvas repacks them.
  • text format:"title-sub"  — title = a short brief name, subtitle = the format
       (e.g. "Long text", "Faceless"), body = one-line summary. The frame title
       should be the brief name too (e.g. "Brief 3 · 147M liters of water").
  • text format:"title" titled "Hook (on-screen)" — body = the exact on-screen
       text the creator must show. This is the primary thing the review checks.
  • text format:"title" titled "Notes" — body = the shooting constraints
       (props, location, sound, "copy the format exactly", pacing, etc.), one per line.
  • text format:"title" titled "Caption" — body = caption guidance (often
       "creator writes their own").
  • text format:"title" titled "App footage" — body = required? + the source link.
  • video block (view:"expanded") — the reference video. analyze_video(reference_url,
       creator_id) first if it isn't analyzed yet; use a kind="reference" creator.
       Some briefs have NO reference, or a non-video reference (an image folder, a
       sound link) — then skip the video block and keep the link in Notes.

IMPORT FROM A CSV BRIEF SHEET: when the user gives a CSV (or a file path to one),
read it and create one brief frame per row. Typical columns map as:
  Hook (text on screen) -> the "Hook (on-screen)" block (the required on-screen text)
  Format                -> the subtitle on the header block
  Reference video       -> analyze_video() then the reference video block
  Caption               -> the "Caption" block
  Notes                 -> the "Notes" block (pull any URLs onto their own lines)
  Requires app footage  -> "App footage" block (yes/no)
  App footage source    -> the link in the "App footage" block
Skip header/title rows. Lay frames out in a grid (increment x by w+gap per frame).
Kick off the reference analyses, then tell the user they're processing.

## 2. DELIVER
When the user pastes a creator's final video URL for a brief, analyze it:
analyze_video(final_url, creator_id) with a kind="reference" creator for that
talent (name it after the creator). Wait until get_video_analysis(video_id)
reports done. Keep track of which video_id is the reference and which is the
delivery — ask the user if it's ambiguous.

## 3. REVIEW  (a frame, payload.role = "review") — the contract
Procedure:
  a. get_video_analysis(delivery_video_id) and, if there is one, the reference.
     The returned video.metrics carries:
       metrics.llm.hook_text / hook_format / hook_strength / hook_opening_words
       metrics.llm.segments[]  (label, start_sec, end_sec, description)
       metrics.llm.tone_adjectives / speaking_style / scriptedness / overall_style_summary
       metrics.llm.cta_present / cta_type / cta_placement
       metrics.deterministic.cut_frequency / avg_shot_len / fast_cut_ratio / talking_head_ratio
       metrics.transcript.text
  b. For the on-screen hook text, the OCR is per shot: get_video_shots(video_id)
     -> shots[].analysis.deterministic.frame.ocr_text + has_onscreen_text. Match the
     brief's required hook against that text (fuzzy / semantic, not exact — OCR is noisy).
  c. Reason over the rubric below and write ONE review frame. For evidence you may
     embed an image block of a key frame (src="/frames/{frame_id}" from get_video_shots).

Rubric — one text block (format:"title") per dimension. Put the status word
(met / partial / missing, or a short verdict) in the TITLE so the sidebar reads it;
put expected-vs-observed + evidence (a timestamp, the OCR text) in the body:
  • "Visual hook"        brief hook text vs the delivery's on-screen OCR + hook timing
                         + metrics.llm.hook_strength.
  • "Reference"          delivery structure (metrics.llm.segments / shot order) vs the
                         reference's. What beat/section is missing or out of order.
  • "Tone / expression"  delivery tone_adjectives + speaking_style vs the reference's
                         (energy, delivery, expression).
  • "Pacing"             delivery cut_frequency / avg_shot_len vs the reference's
                         (state both numbers; "too slow / matches / too fast").
  • "Constraints"        each Notes item, one line: met / missing / can't verify, with
                         evidence. Include the app-footage requirement here.
  • "Missing"            a plain list of everything the brief asked for that is not in
                         the delivery. This is the most important block — it lets the
                         user trust nothing was dropped without re-watching the footage.
  • "Strengths"          what the creator did well (keep it honest and short).
Header block (top, format:"title-sub"): title = "Review · {brief name} · {creator}",
subtitle = "{APPROVE | REVISE | RESHOOT} · {score}/100", body = a one-line summary.
Then a video block (view:"expanded") of the delivery so the user sees what's reviewed.

DEGRADE HONESTLY, never fabricate:
  • No reference, or its analysis failed (e.g. Instagram/Drive that wouldn't download):
    skip the reference / tone-vs-reference / pacing-vs-reference comparisons and SAY so
    in those blocks ("no reference to compare; checked against the brief text only").
  • Audio / exact-sound match is NOT verifiable (no audio fingerprinting): in
    Constraints, mark any "use this sound" note as "can't verify".
  • If the delivery isn't analyzed yet, don't review — say it's still processing.

## 4. COACH — the note to send the creator
End the review frame with a text block (format:"title") titled "Send to creator":
the body is a short, ready-to-send message the agency can copy-paste. Lead with one
genuine strength, then the 2-4 things to fix as plain bullets (visual hook, reference,
tone/expression, pacing), each with the concrete fix. Keep it kind and specific.
Follow the WRITING STYLE rules: plain words, no em dashes, no hype, no emojis unless
the user asks. You can also spin this note into its own frame (role:"coaching") to
hand off cleanly.
IMPROVEMENT OVER TIME: if the same creator has earlier review frames in the project
(list_artifacts, role:"review"), compare scores and call out the trend in one line
("hook timing 0:04 -> 0:01 across three, improving"). Keep it as text for now.

## OUTPUT CRITERIA — every review frame must have
  payload.role = "review"; the header block with verdict + score; the Visual hook,
  Reference, Tone/expression, Pacing, Constraints, Missing, Strengths blocks (a
  reference-dependent block may say "no reference" but must still be present); the
  delivery video block; and the "Send to creator" note. Build it with one
  create_artifact call (update_artifact to revise it later, never a duplicate).
"""
