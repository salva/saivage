import { loadConfig, configPath, writeDefaultConfig } from "../config.js";

export async function showConfig(): Promise<void> {
  writeDefaultConfig();
  const config = loadConfig();
  console.log(`Config path: ${configPath()}`);
  console.log(JSON.stringify(config, null, 2));
}
