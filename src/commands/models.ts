import { loadConfig } from "../config.js";
import { ModelRouter, parseModelId } from "../providers/index.js";

export async function listModels(): Promise<void> {
  const config = loadConfig();
  const router = new ModelRouter(config);

  console.log("Model assignments:");
  for (const [role, model] of Object.entries(config.models)) {
    console.log(`  ${role}: ${model}`);
  }

  console.log("\nRegistered providers:");
  for (const name of router.listProviders()) {
    const provider = router.getProvider(name);
    const available = provider ? await provider.isAvailable() : false;
    console.log(`  ${name}: ${available ? "✓ available" : "✗ not available"}`);
  }

  if (Object.keys(config.failover).length > 0) {
    console.log("\nFailover chains:");
    for (const [model, chain] of Object.entries(config.failover)) {
      console.log(`  ${model} → ${chain.join(" → ")}`);
    }
  }
}

export async function testModels(model?: string): Promise<void> {
  const config = loadConfig();
  const router = new ModelRouter(config);

  const modelsToTest = model
    ? [model]
    : [...new Set(Object.values(config.models))];

  for (const modelSpec of modelsToTest) {
    const { provider: providerName } = parseModelId(modelSpec);
    process.stdout.write(`Testing ${modelSpec}... `);

    const provider = router.getProvider(providerName);
    if (!provider) {
      console.log("✗ provider not registered");
      continue;
    }

    const available = await provider.isAvailable();
    if (!available) {
      console.log("✗ not available (missing API key?)");
      continue;
    }

    try {
      const start = Date.now();
      const response = await router.chat({
        modelSpec,
        model: parseModelId(modelSpec).model,
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "Say 'hello' and nothing else." }],
        maxTokens: 32,
      });
      const elapsed = Date.now() - start;
      console.log(
        `✓ ${elapsed}ms — "${response.content.trim()}" (${response.usage.inputTokens}+${response.usage.outputTokens} tokens)`,
      );
    } catch (err) {
      console.log(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
