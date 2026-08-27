import { describe, expect, it } from "vitest";
import { clampInspectorWidth } from "./RecordInspector";

describe("record inspector sizing", () => {
  it("keeps the configured width within desktop viewport bounds", () => {
    expect(clampInspectorWidth(200, 1400)).toBe(320);
    expect(clampInspectorWidth(640, 1400)).toBe(640);
    expect(clampInspectorWidth(1200, 1400)).toBe(960);
  });

  it("fits safely into narrow viewports", () => {
    expect(clampInspectorWidth(430, 360)).toBe(280);
  });
});
