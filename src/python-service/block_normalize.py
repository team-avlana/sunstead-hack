"""Make artifact-payload blocks *self-describing*.

The canvas renders several text-block layouts (plain | title | title-sub) and
video-block detail levels (compact | expanded | full). None of this lives in a
dedicated column — it all rides inside the artifact `payload` jsonb. The canvas
historically inferred a text block's layout from its rendered HTML (a leading
<h1>/<h2>), so an agent that wrote "title + text" as a flat string lost the
distinction and the block fell back to plain text.

This module guarantees that every element a write produces carries an explicit
display *type* and its structured *contents*:

  text  → {format, title, subtitle, body}  (+ a canonical `content` HTML rebuilt
           from those parts, so the renderer infers the right layout either way)
  video → {view, …}

It is called from db.create_artifact / db.update_artifact, so every write path
(the MCP tools and the canvas PUT route) ends up normalized. Normalization is
idempotent — running it on already-normalized data is a no-op.

Keep the text-layout rules in sync with canvas-ui/lib/blockTypes.ts
(FORMAT_SLOTS / inferFormat / composeTextHtml).
"""

from __future__ import annotations

import re
from typing import Any

TEXT_FORMATS = ("plain", "title", "title-sub")
VIDEO_VIEWS = ("compact", "expanded", "full")


# ── agent-facing taxonomy guide ──────────────────────────────────────────────────
#
# The single human/agent-readable description of the block taxonomy. It is injected
# into the MCP server `instructions` and the create_/update_artifact docstrings so the
# agent (the user's own Claude client) always knows which block type + format to pick
# for the content it has, and which fields to fill. Keep it in sync with the rules
# enforced below and mirrored in canvas-ui/lib/blockTypes.ts.
BLOCK_TAXONOMY_GUIDE = """\
BLOCK TAXONOMY — a frame's payload.elements is a list of blocks. The canvas renders a
distinct card per block type/format, so the structure you choose IS the layout the user
sees. Pick the type (and, for text, the format) that best fits the content you actually
have, then fill the matching fields. Match content to format — do not flatten everything
into plain text.

TEXT  (type:"text") — choose `format` by what the content is:
  • "plain"      fields {body}                 — a paragraph / notes / prose, no heading.
  • "title"      fields {title, body}          — a heading + supporting text. USE THIS
       whenever you have a name/label AND some text: a "Hook", a beat ("Beat 1 — …"),
       a section, a named idea. Do NOT bury the title as the first line of the body —
       that renders as plain text and loses the card layout.
  • "title-sub"  fields {title, subtitle, body} — heading + a short qualifier/tagline +
       text: e.g. a scene label + timecode/one-liner + its description.
  Body newlines become separate paragraphs. Set `format` explicitly and fill the
  structured title/subtitle/body parts (a raw {"content":"<h1>…</h1><p>…</p>"} HTML
  string is still accepted for back-compat and parsed back into those parts).

VIDEO (type:"video") — choose `view` detail level: "compact" | "expanded" | "full".
  Carries a video_id (from analyze_video / get_video_analysis). Use "compact" in dense
  flows, "full" when the storyboard/transcript should be visible.

IMAGE (type:"image") — a frame/thumbnail. Fields {src, frame_id, caption?}. Use
  src="/frames/{frame_id}" with a frame_id from get_video_shots / get_video_analysis.

Every element needs a stable `id`; x/y are RELATIVE to the frame's top-left (w/h optional).

MAPPING ANALYSIS → BLOCKS — when turning analysis results into a frame, match each piece
to the format that fits it: a video's hook → format:"title" titled "Hook"; each storyboard
scene → an image block (its frame_id) paired with a format:"title-sub" text block
(scene label / timecode / description); freeform notes, tags, or transcript → format:"plain".
"""


# ── agent-facing writing style ───────────────────────────────────────────────────
#
# House style for ANY prose the agent writes into artifacts (titles, bodies, hooks,
# beats, scene descriptions, notes). Injected alongside BLOCK_TAXONOMY_GUIDE into the
# MCP server `instructions` and the create_/update_artifact docstrings so the agent
# (the user's own Claude client) writes like a human creator, not an assistant. The
# goal: kill the "AI voice" — the hedging, the hype words, the em-dash sprawl.
WRITING_STYLE_GUIDE = """\
WRITING STYLE — applies to every word you put on the canvas (titles, bodies, hooks,
beats, scene descriptions, notes). The user is a creator; write the way they would, not
the way an AI assistant does.

  • Be concise. Cut every word that does not change the meaning. Favor short sentences
    and one idea per line. If a line works at half the length, halve it.
  • Plain words. Say "use", "make", "start", "show" — not "leverage", "utilize",
    "craft", "embark on", "elevate".
  • No em dashes (—) or double hyphens (--). Use a period, a comma, or a new line.
  • No AI filler or hype. Drop "dive in", "unleash", "seamless", "game-changer",
    "in today's world", "when it comes to", "it's worth noting", "powerful", "robust",
    "captivating", "elevate your". No "not just X, but Y" framing. No throat-clearing
    intros and no "in summary" wrap-ups.
  • Don't stack synonyms or pile on adjectives. Say it once, concretely.
  • Be specific over impressive. Name the thing, the number, the action. Show, don't
    describe how great it is.
  • Match the creator's own voice when a style profile or memory gives you one;
    otherwise stay neutral and direct.
  • No emojis unless the user asks for them.
"""

# Which heading slots each text format carries above the body. Mirrors
# FORMAT_SLOTS in canvas-ui/lib/blockTypes.ts.
_FORMAT_SLOTS: dict[str, tuple[bool, bool]] = {
    "plain": (False, False),
    "title": (True, False),
    "title-sub": (True, True),
}


def _is_str(v: Any) -> bool:
    return isinstance(v, str) and v.strip() != ""


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ── text composition / parsing ──────────────────────────────────────────────────


def compose_text_html(fmt: str, title: str, subtitle: str, body: str) -> str:
    """Canonical block HTML for a format: <h1>/<h2> heading slots, then one <p>
    per body line. Mirrors composeTextHtml() in canvas-ui/lib/blockTypes.ts."""
    want_title, want_sub = _FORMAT_SLOTS.get(fmt, _FORMAT_SLOTS["plain"])
    head = ""
    if want_title:
        head += f"<h1>{_esc(title)}</h1>"
    if want_sub:
        head += f"<h2>{_esc(subtitle)}</h2>"
    lines = body.split("\n") if body else [""]
    body_html = "".join(f"<p>{_esc(line)}</p>" for line in lines) or "<p></p>"
    return head + body_html


_H1_RE = re.compile(r"\s*<h1[^>]*>(.*?)</h1>", re.IGNORECASE | re.DOTALL)
_H2_RE = re.compile(r"\s*<h2[^>]*>(.*?)</h2>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_BLOCK_END_RE = re.compile(r"</(p|div|h[1-6]|li)>", re.IGNORECASE)
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)


def _strip_inline(html: str) -> str:
    """Plain text of an inline fragment (a heading's inner HTML)."""
    return _TAG_RE.sub("", _BR_RE.sub("\n", html)).strip()


def _body_text(html: str) -> str:
    """Plain text of body markup, one line per block-level node (so
    `<p>a</p><p>b</p>` → "a\\nb"). Plain (tagless) text passes through verbatim."""
    if "<" not in html:
        return html.strip()
    t = _BLOCK_END_RE.sub("\n", html)
    t = _BR_RE.sub("\n", t)
    t = _TAG_RE.sub("", t)
    lines = [ln.strip() for ln in t.split("\n")]
    return "\n".join(ln for ln in lines if ln)


def infer_format_from_html(content: str) -> str:
    """Detect a text block's format from its leading headings — mirrors
    inferFormat() in canvas-ui/lib/blockTypes.ts (H1 ⇒ title, H1+H2 ⇒ +subtitle)."""
    rest = content.lstrip()
    m1 = _H1_RE.match(rest)
    if not m1:
        return "plain"
    return "title-sub" if _H2_RE.match(rest[m1.end():].lstrip()) else "title"


def _parts_from_html(content: str) -> tuple[str, str, str, str]:
    """Best-effort split of `content` (HTML or plain text) into
    (format, title, subtitle, body)."""
    rest = content.strip()
    title = subtitle = ""
    fmt = "plain"
    m1 = _H1_RE.match(rest)
    if m1:
        title = _strip_inline(m1.group(1))
        rest = rest[m1.end():].lstrip()
        fmt = "title"
        m2 = _H2_RE.match(rest)
        if m2:
            subtitle = _strip_inline(m2.group(1))
            rest = rest[m2.end():].lstrip()
            fmt = "title-sub"
    return fmt, title, subtitle, _body_text(rest)


# ── element normalizers ─────────────────────────────────────────────────────────


def normalize_text_element(el: dict) -> dict:
    """Return a text element that explicitly carries its layout `format` plus
    structured `title`/`subtitle`/`body` and a canonical `content` HTML rebuilt
    from them. Structured parts win; otherwise they're recovered from `content`."""
    raw_fmt = el.get("format")
    fmt = raw_fmt if raw_fmt in TEXT_FORMATS else None

    title = el.get("title") if isinstance(el.get("title"), str) else ""
    subtitle = el.get("subtitle") if isinstance(el.get("subtitle"), str) else ""
    body = el.get("body") if isinstance(el.get("body"), str) else ""

    if not (_is_str(title) or _is_str(subtitle) or _is_str(body)):
        # No structured parts — recover them from `content` (HTML or plain) or a label.
        content = el.get("content")
        if isinstance(content, str) and content.strip():
            d_fmt, title, subtitle, body = _parts_from_html(content)
            if fmt is None:
                fmt = d_fmt
        else:
            label = el.get("label") or el.get("text")
            body = label if isinstance(label, str) else ""

    if fmt is None:
        fmt = "title-sub" if _is_str(subtitle) else ("title" if _is_str(title) else "plain")

    # Never drop text: a format that lacks a heading slot demotes that slot's
    # text into the body (mirrors restructure() in canvas-ui/lib/blockTypes.ts).
    want_title, want_sub = _FORMAT_SLOTS[fmt]
    demoted: list[str] = []
    if not want_title and _is_str(title):
        demoted.append(title.strip())
    if not want_sub and _is_str(subtitle):
        demoted.append(subtitle.strip())
    if demoted:
        body = "\n".join(demoted + ([body] if _is_str(body) else []))
    if not want_title:
        title = ""
    if not want_sub:
        subtitle = ""

    return {
        **el,
        "type": "text",
        "format": fmt,
        "title": title,
        "subtitle": subtitle,
        "body": body,
        "content": compose_text_html(fmt, title, subtitle, body),
    }


def normalize_video_element(el: dict) -> dict:
    """Return a video element that explicitly carries its `view` detail level."""
    view = el.get("view")
    if view in VIDEO_VIEWS:
        return {**el, "type": "video"}
    return {**el, "type": "video", "view": "compact"}


def _looks_like_text(el: dict) -> bool:
    return any(k in el for k in ("content", "body", "title", "subtitle", "format"))


def normalize_payload(payload: Any) -> Any:
    """Normalize a frame payload's `elements` so each block is self-describing.
    Non-frame payloads (no `elements` list) pass through untouched."""
    if not isinstance(payload, dict):
        return payload
    elements = payload.get("elements")
    if not isinstance(elements, list):
        return payload

    out: list[Any] = []
    for el in elements:
        if not isinstance(el, dict):
            out.append(el)
            continue
        etype = el.get("type")
        if etype == "video":
            out.append(normalize_video_element(el))
        elif etype == "text" or (etype is None and _looks_like_text(el)):
            out.append(normalize_text_element(el))
        else:
            out.append(el)  # image / unknown — leave as-is
    return {**payload, "elements": out}
