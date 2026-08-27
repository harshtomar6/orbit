import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const gatewayEnvPath = fileURLToPath(new URL("../.env", import.meta.url));

try {
  loadEnvFile(gatewayEnvPath);
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
