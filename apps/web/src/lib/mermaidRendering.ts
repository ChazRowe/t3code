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
  const source = `${themeDirective(theme)}${stripLeakedControlTags(code)}`;
  const { svg } = await mermaid.render(renderId, source);
  return { svg };
}
