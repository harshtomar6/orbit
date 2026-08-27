import { describe, expect, it } from "vitest";
import { formatCompactCount } from "./format-count";

describe("formatCompactCount", () => {
  it("keeps small values exact and abbreviates large collection counts", () => {
    expect(formatCompactCount(340)).toBe("340");
    expect(formatCompactCount(1_200)).toBe("1.2k");
    expect(formatCompactCount(96_000)).toBe("96k");
    expect(formatCompactCount(1_900_000)).toBe("1.9m");
  });
});
