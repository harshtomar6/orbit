import { describe, expect, it } from "vitest";
import { closeExploreTab, cycleExploreTab, openExploreTab, type ExploreTabTarget } from "./explore-tabs";

const target = (object: string): ExploreTabTarget => ({ connectionId: "local-1", connectionName: "Local", databaseKind: "mongodb", namespace: "app", object, objectKind: "collection" });

describe("Explore workspace tabs", () => {
  it("reuses the single preview tab until it is promoted", () => {
    const users = openExploreTab([], target("users"));
    const orders = openExploreTab(users.tabs, target("orders"));
    expect(orders.tabs.map((tab) => tab.object)).toEqual(["orders"]);

    const pinned = openExploreTab(orders.tabs, target("orders"), true);
    const events = openExploreTab(pinned.tabs, target("events"));
    expect(events.tabs.map((tab) => [tab.object, tab.preview])).toEqual([["orders", false], ["events", true]]);
  });

  it("activates an existing tab without duplicating it", () => {
    const users = openExploreTab([], target("users"), true);
    const orders = openExploreTab(users.tabs, target("orders"), true);
    const reopened = openExploreTab(orders.tabs, target("users"));
    expect(reopened.tabs).toHaveLength(2);
    expect(reopened.activeId).toContain("users");
  });

  it("selects a neighboring tab when the active one closes", () => {
    const users = openExploreTab([], target("users"), true);
    const orders = openExploreTab(users.tabs, target("orders"), true);
    const events = openExploreTab(orders.tabs, target("events"), true);
    const closed = closeExploreTab(events.tabs, orders.activeId, orders.activeId);
    expect(closed.tabs.map((tab) => tab.object)).toEqual(["users", "events"]);
    expect(closed.activeId).toContain("events");
    expect(cycleExploreTab(closed.tabs, closed.activeId, 1)).toContain("users");
  });
});
