import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataValue, parseJsonContainer } from "./DataValue";

describe("DataValue MongoDB references", () => {
  const objectId = { $oid: "507f1f77bcf86cd799439011" };

  it("renders a linked ObjectId as an actionable cell", () => {
    const html = renderToStaticMarkup(<DataValue value={objectId} mongo onReference={() => undefined} />);
    expect(html).toContain("mongo-reference");
    expect(html).toContain("Open linked document");
  });

  it("keeps an ObjectId read-only when no resolver is available", () => {
    const html = renderToStaticMarkup(<DataValue value={objectId} mongo />);
    expect(html).not.toContain("mongo-reference");
    expect(html).toContain("$oid");
  });

  it("detects JSON objects and arrays stored as strings", () => {
    expect(parseJsonContainer('{"profile":{"role":"admin"}}')?.fromString).toBe(true);
    expect(parseJsonContainer("[1,2,3]")?.value).toEqual([1, 2, 3]);
    expect(parseJsonContainer("{not-json}")).toBeUndefined();
  });

  it("renders detected JSON as an independently expandable tree", () => {
    const html = renderToStaticMarkup(<DataValue value={'{"profile":{"role":"admin"},"active":true}'} expanded />);
    expect(html).toContain('<details class="json-tree"');
    expect(html).toContain("JSON");
    expect(html).toContain("profile");
    expect(html).toContain("object · 1 fields");
  });

  it("renders recognized status fields without changing ordinary string fields", () => {
    const status = renderToStaticMarkup(<DataValue fieldName="paymentStatus" value="pending" />);
    const ordinary = renderToStaticMarkup(<DataValue fieldName="role" value="active" />);
    expect(status).toContain("status-badge warning");
    expect(status).toContain("pending");
    expect(ordinary).not.toContain("status-badge");
  });

  it("formats status fields nested inside expanded JSON", () => {
    const html = renderToStaticMarkup(<DataValue value={{ workflow: { status: "completed" } }} expanded />);
    expect(html).toContain("status-badge success");
  });

  it("renders PostgreSQL native types and foreign-key targets", () => {
    const date = renderToStaticMarkup(<DataValue postgres nativeType="date" value="2026-08-23" />);
    const foreignKey = renderToStaticMarkup(<DataValue postgres nativeType="uuid" reference={{ namespace: "public", object: "users", column: "id" }} value="74ef" />);
    expect(date).toContain("postgres-value date");
    expect(date).toContain("DATE");
    expect(foreignKey).toContain("postgres-value reference");
    expect(foreignKey).toContain("public.users.id");
  });

  it("renders an actionable PostgreSQL foreign key when a resolver is available", () => {
    const html = renderToStaticMarkup(<DataValue postgres nativeType="uuid" reference={{ namespace: "public", object: "users", column: "id" }} value="74ef" onReference={() => undefined} />);
    expect(html).toContain("postgres-reference");
    expect(html).toContain("Open referenced row in public.users");
  });

  it("renders PostgreSQL enums with semantic status badges", () => {
    const known = renderToStaticMarkup(<DataValue postgres nativeType="payment_state" enumValues={["pending", "paid", "failed"]} value="pending" />);
    const custom = renderToStaticMarkup(<DataValue postgres nativeType="membership_tier" enumValues={["starter", "enterprise"]} value="enterprise" />);
    expect(known).toContain("status-badge warning");
    expect(known).toContain("Allowed: pending, paid, failed");
    expect(custom).toContain("status-badge enum-blue");
  });
});
