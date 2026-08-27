import "./env.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createPersistentConnectionStore } from "./connection-store.js";
import { createPersistentViewStore } from "./view-store.js";
import { createAskProvider } from "./ask-provider.js";
import { createPersistentSchemaProfileStore } from "./schema-profile-store.js";

const port = Number(process.env.PORT ?? 8787);
if (process.env.NODE_ENV === "production" && !process.env.ORBIT_API_TOKEN) throw new Error("ORBIT_API_TOKEN is required in production.");
const store = await createPersistentConnectionStore();
const viewStore = await createPersistentViewStore();
const schemaProfileStore = await createPersistentSchemaProfileStore();
serve({ fetch: createApp(store, true, createAskProvider(), viewStore, schemaProfileStore).fetch, port }, (info) => console.log(`Orbit gateway listening on http://localhost:${info.port}`));
