import { describe, expect, it } from "vitest";
import { enumTone, isStatusField, parseStatus, statusTone } from "./status-format";

describe("status formatting", () => {
  it("recognizes status fields without treating geographic state fields as statuses", () => {
    expect(isStatusField("status")).toBe(true);
    expect(isStatusField("paymentStatus")).toBe(true);
    expect(isStatusField("workflow_state")).toBe(true);
    expect(isStatusField("address_state")).toBe(false);
  });

  it("maps known values to semantic tones", () => {
    expect(parseStatus("status", "completed")?.tone).toBe("success");
    expect(parseStatus("syncStatus", "in-progress")?.tone).toBe("info");
    expect(parseStatus("payment_status", "pending")?.tone).toBe("warning");
    expect(parseStatus("status", "FAILED")?.tone).toBe("danger");
    expect(statusTone("paid")).toBe("success");
    expect(statusTone("awaiting_fulfilment")).toBe("neutral");
    expect(enumTone("paid", ["pending", "paid", "failed"])).toBe("success");
    expect(enumTone("enterprise", ["starter", "enterprise"])).toBe("enum-blue");
  });

  it("keeps domain-specific values neutral and leaves non-status values untouched", () => {
    expect(parseStatus("order_status", "awaiting_fulfilment")).toMatchObject({ label: "awaiting_fulfilment", tone: "neutral" });
    expect(parseStatus("role", "active")).toBeUndefined();
    expect(parseStatus("status", 1)).toBeUndefined();
  });
});
