import { cpSync } from "fs";
import { existsSync } from "fs";

if (existsSync("src/public")) {
  cpSync("src/public", "dist/public", { recursive: true });
}