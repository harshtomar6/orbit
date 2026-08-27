import { describe, expect, it } from "vitest";
import { QueryRejectedError, assertReadOnlyQuery, decodeCursor, encodeCursor, parseReadOnlyMongoPipeline } from "./index.js";

describe("query safety", () => {
  it.each(["SELECT * FROM users", "WITH active AS (SELECT 1) SELECT * FROM active", "EXPLAIN SELECT 1"])("allows read-only SQL: %s", (query) => expect(() => assertReadOnlyQuery(query)).not.toThrow());
  it.each(["DELETE FROM users", "SELECT 1; DROP TABLE users", "WITH changed AS (UPDATE users SET name='x' RETURNING *) SELECT * FROM changed"])("rejects destructive SQL: %s", (query) => expect(() => assertReadOnlyQuery(query)).toThrow(QueryRejectedError));
});

describe("MongoDB query safety", () => {
  it("accepts read-only aggregation stages", () => expect(parseReadOnlyMongoPipeline('[{"$match":{"status":"active"}},{"$group":{"_id":"$plan","count":{"$sum":1}}}]')).toHaveLength(2));
  it.each(['[{"$out":"archive"}]', '[{"$merge":{"into":"archive"}}]', '[{"$project":{"value":{"$function":{"body":"x","args":[],"lang":"js"}}}}]'])("rejects unsafe pipelines", (pipeline) => expect(() => parseReadOnlyMongoPipeline(pipeline)).toThrow(QueryRejectedError));
});

describe("opaque cursors", () => {
  it("round trips an offset", () => expect(decodeCursor(encodeCursor(42))).toBe(42));
  it("rejects malformed cursors", () => expect(() => decodeCursor("not-a-cursor")).toThrow(QueryRejectedError));
});
