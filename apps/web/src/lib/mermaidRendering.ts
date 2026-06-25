// Lazily-loaded mermaid renderer.
//
// mermaid is a large dependency (hundreds of KB), so it is dynamically imported
// the first time a diagram actually needs rendering and is never pulled into the
// main bundle. Rendering happens off the React render path (in an effect) because
// mermaid.render is async and touches the DOM.

import type { Mermaid } from "mermaid";

let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (mermaidPromise == null) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        // Sandbox label HTML so a malicious or garbled diagram can't inject
        // script. mermaid's SVG is injected via dangerouslySetInnerHTML, which
        // bypasses the markdown sanitize schema, so this is our security
        // boundary for diagram content.
        securityLevel: "strict",
        // We render our own fallback UI on failure; don't let mermaid inject its
        // own error SVG into the output.
        suppressErrorRendering: true,
        fontFamily: "inherit",
      });
      return mermaid;
    });
    // If the dynamic import itself fails (e.g. a chunk can't be fetched), clear
    // the cached promise so a later diagram can retry the load.
    mermaidPromise.catch(() => {
      mermaidPromise = null;
    });
  }
  return mermaidPromise;
}

let renderSeq = 0;

function themeDirective(theme: "light" | "dark"): string {
  // Set the theme per-diagram via an init directive rather than mutating
  // mermaid's global config, which would race across concurrently-rendered
  // diagrams. A user-authored init directive later in the source still wins.
  const mermaidTheme = theme === "dark" ? "dark" : "default";
  return `%%{init: {"theme": "${mermaidTheme}"}}%%\n`;
}

// Agent output occasionally leaks tool-call control tags (e.g. a stray
// "</parameter>") into assistant text. In prose these are silently dropped by the
// markdown sanitizer, but inside a code fence they survive as literal text and
// fail the mermaid parse. They are never valid diagram syntax, so strip them
// before handing the source to mermaid.
const LEAKED_CONTROL_TAG_REGEX = /<\/?(?:antml:)?(?:function_calls|invoke|parameter)\b[^>]*>/gi;

export function stripLeakedControlTags(code: string): string {
  return code.replace(LEAKED_CONTROL_TAG_REGEX, "");
}

// A handful of CSS named colors agent-authored diagrams reach for. Anything not
// here (or a hex / rgb() literal) is left alone — we only inject a text color
// when we can actually measure the fill's luminance.
const NAMED_FILL_COLORS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  gray: "#808080",
  grey: "#808080",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  lightblue: "#add8e6",
  lightgreen: "#90ee90",
  lightyellow: "#ffffe0",
  lightpink: "#ffb6c1",
  pink: "#ffc0cb",
  beige: "#f5f5dc",
  ivory: "#fffff0",
  whitesmoke: "#f5f5f5",
};

// Perceived luminance (0..1, sRGB-weighted) of a CSS color literal, or null when
// the color is transparent/unparseable (in which case we leave the fill alone).
function fillLuminance(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (value === "none" || value === "transparent") {
    return null;
  }

  let r: number;
  let g: number;
  let b: number;

  const rgbMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(value);
  if (rgbMatch) {
    r = Number(rgbMatch[1]);
    g = Number(rgbMatch[2]);
    b = Number(rgbMatch[3]);
  } else {
    const hex = (NAMED_FILL_COLORS[value] ?? value).replace(/^#/, "");
    const expanded =
      hex.length === 3 || hex.length === 4
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(expanded)) {
      return null;
    }
    r = parseInt(expanded.slice(0, 2), 16);
    g = parseInt(expanded.slice(2, 4), 16);
    b = parseInt(expanded.slice(4, 6), 16);
  }

  if (![r, g, b].every((c) => Number.isFinite(c))) {
    return null;
  }
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// `classDef foo fill:#eef6ff,stroke:#2471a3;` / `style nodeId fill:#eef6ff;` —
// keyword, target, then a comma-separated style list (optional trailing `;`).
const STYLE_STATEMENT_REGEX = /^(\s*)(classDef|style)\s+(\S+)\s+(.+?)(;?)(\s*)$/;

function injectContrastTextColor(styleBody: string): string {
  if (/(?:^|,)\s*color\s*:/i.test(styleBody)) {
    return styleBody;
  }
  // Capture the fill value, keeping an rgb()/rgba() literal intact (its inner
  // commas would otherwise look like style-list separators).
  const fillMatch = /(?:^|,)\s*fill\s*:\s*(rgba?\([^)]*\)|[^,]+)/i.exec(styleBody);
  if (!fillMatch) {
    return styleBody;
  }
  const luminance = fillLuminance(fillMatch[1] ?? "");
  if (luminance == null) {
    return styleBody;
  }
  // Light fill → near-black text, dark fill → near-white text.
  const textColor = luminance > 0.6 ? "#1a1a1a" : "#f5f5f5";
  return `${styleBody},color:${textColor}`;
}

// Diagram authors (very often LLM-generated diagrams) set an explicit light fill
// via `classDef`/`style` but omit a text `color:`. Under the light theme the
// default node text is dark and contrasts fine; under the dark theme mermaid
// flips the default node text to a light color, so those light-fill nodes render
// light-on-light and are illegible. Mermaid never auto-contrasts label text
// against an explicit fill, so we derive a contrasting `color:` from the fill's
// luminance and inject it when the author didn't set one. Theme-default nodes
// (no explicit fill) are untouched — they're already theme-correct.
export function ensureNodeTextContrast(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      const match = STYLE_STATEMENT_REGEX.exec(line);
      if (!match) {
        return line;
      }
      const [, indent = "", keyword, target, styleBody = "", semicolon = "", trailing = ""] = match;
      const next = injectContrastTextColor(styleBody);
      return next === styleBody
        ? line
        : `${indent}${keyword} ${target} ${next}${semicolon}${trailing}`;
    })
    .join("\n");
}

export interface MermaidRenderResult {
  readonly svg: string;
}

/**
 * Render mermaid diagram source to an SVG string. Rejects if the source fails to
 * parse — callers should fall back to showing the raw source.
 */
export async function renderMermaid(
  code: string,
  theme: "light" | "dark",
): Promise<MermaidRenderResult> {
  const mermaid = await loadMermaid();
  renderSeq += 1;
  const renderId = `chat-mermaid-${renderSeq}`;
  const source = `${themeDirective(theme)}${ensureNodeTextContrast(stripLeakedControlTags(code))}`;
  const { svg } = await mermaid.render(renderId, source);
  return { svg };
}
