// Cross-process writer fixture used by store.test.ts to drive concurrent
// saveProfile() calls from multiple Node processes. The parent forks this
// module via tsx so the writer runs against the TypeScript source — no
// dist/auth/* build artifact is involved.
import { saveProfile } from "../index.js";

const key = process.env["SAIVAGE_TARGET_KEY"];
const base64 = process.env["SAIVAGE_TARGET_BODY_BASE64"];
if (!key || !base64) {
  throw new Error("concurrent-writer fixture requires SAIVAGE_TARGET_KEY and SAIVAGE_TARGET_BODY_BASE64");
}
const body = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
await saveProfile(key, body);
