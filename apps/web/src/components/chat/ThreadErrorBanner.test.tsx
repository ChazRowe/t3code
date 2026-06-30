import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("renders nothing when there is no error", () => {
    expect(renderToStaticMarkup(<ThreadErrorBanner error={null} />)).toBe("");
  });

  it("places the error text in the alert's flexible content column, not the fixed icon box", () => {
    const error = "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use";
    const html = renderToStaticMarkup(<ThreadErrorBanner error={error} />);

    expect(html).toContain(error);
    // The fixed-size icon box renders before the flexible content column
    // (min-w-0 flex-1). If the description is buried inside the Tooltip
    // wrapper, Alert misfiles it into that 16px icon box and the error text
    // ends up BEFORE the content column (clipped to a few chars per line).
    // Correctly slotted, the text lives inside the content column, after it.
    expect(html.indexOf(error)).toBeGreaterThan(html.indexOf("flex-1"));
    expect(html).toContain('data-slot="alert-description"');
  });
});
