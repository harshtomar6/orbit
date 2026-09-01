import { describe, expect, it } from "vitest";
import { transportForSection } from "./runtime";

describe("transportForSection", () => {
  it("uses direct database drivers only for desktop Explore", () => {
    expect(transportForSection("desktop", "explore")).toBe("local");
    expect(transportForSection("desktop", "ask")).toBe("gateway");
    expect(transportForSection("desktop", "views")).toBe("gateway");
  });

  it("keeps every web surface on the gateway", () => {
    expect(transportForSection("web", "explore")).toBe("gateway");
    expect(transportForSection("web", "ask")).toBe("gateway");
    expect(transportForSection("web", "views")).toBe("gateway");
  });
});
