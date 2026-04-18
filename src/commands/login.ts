/**
 * CLI login command — OAuth login for model providers.
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getOAuthProviders, getOAuthProvider, saveProfile } from "../auth/index.js";
import type { AuthProfile } from "../auth/types.js";

export async function loginCommand(providerArg?: string): Promise<void> {
  const allProviders = getOAuthProviders();

  if (!providerArg) {
    // List available OAuth providers
    console.log("\nAvailable OAuth providers:\n");
    for (const p of allProviders) {
      console.log(`  ${p.id.padEnd(16)} ${p.name}`);
    }
    console.log("\nUsage: saivage login <provider>\n");
    return;
  }

  const provider = getOAuthProvider(providerArg);
  if (!provider) {
    console.error(`Unknown OAuth provider: ${providerArg}`);
    console.error(`Available: ${allProviders.map((p) => p.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`\nLogging in with ${provider.name}...\n`);

  const rl = createInterface({ input, output });

  try {
    const credentials = await provider.login({
      onAuth(info) {
        console.log(info.instructions ?? "");
        console.log(`\nOpen this URL in your browser:\n\n  ${info.url}\n`);

        // Try to open the browser automatically
        import("node:child_process").then(({ exec }) => {
          const cmd =
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
                ? "start"
                : "xdg-open";
          exec(`${cmd} "${info.url}"`, () => { /* ignore errors */ });
        }).catch(() => { /* ignore */ });
      },
      async onPrompt(prompt) {
        const answer = await rl.question(prompt.message + " ");
        return answer;
      },
      onProgress(message) {
        console.log(message);
      },
    });

    // Build profile key (provider:email or provider)
    const email = credentials.email;
    const profileKey = email ? `${provider.id}:${email}` : provider.id;

    const profile: AuthProfile = {
      type: "oauth",
      provider: provider.id,
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      ...(email ? { email } : {}),
    };

    saveProfile(profileKey, profile);

    console.log(`\n✓ Logged in as ${email ?? profileKey}`);
    console.log(`  Credentials saved to ~/.saivage/auth-profiles.json`);
    console.log(`  Token expires: ${new Date(credentials.expires).toLocaleString()}\n`);
  } catch (err) {
    console.error(`\nLogin failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  } finally {
    rl.close();
  }
}
