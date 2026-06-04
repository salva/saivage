import { hasOAuthCredentials } from "../auth/index.js";
import type { RuntimeProviderAccountLike, RuntimeProviderConfigLike } from "../routing/resolver.js";
import { CopilotProvider } from "./copilot.js";
import { LlamaCppProvider } from "./llamacpp.js";
import { NvidiaNimProvider } from "./nvidia-nim.js";
import { OllamaProvider } from "./ollama.js";
import { PiAiProvider } from "./pi-ai.js";
import type { CredentialRequest, CredentialResolver } from "./credential-resolver.js";
import type { ModelProvider } from "./types.js";

interface ProviderDescriptor<N extends string = string> {
  readonly name: N;
  shouldRegister(ctx: { cfg: RuntimeProviderConfigLike | undefined; hasAccounts: boolean }): Promise<boolean>;
  create(ctx: { providerConfig: RuntimeProviderConfigLike | undefined; accountConfig: RuntimeProviderAccountLike | undefined }): ModelProvider;
}

function makePiAiDescriptor<N extends string>(
  name: N,
  shouldRegister: ProviderDescriptor<N>["shouldRegister"],
): ProviderDescriptor<N> {
  return {
    name,
    shouldRegister,
    create: ({ providerConfig, accountConfig }) => {
      const provider = new PiAiProvider(name);
      const apiKey = accountConfig?.apiKey ?? providerConfig?.apiKey;
      if (apiKey) provider.setApiKey(apiKey);
      return provider;
    },
  };
}

const PROVIDER_DESCRIPTORS = [
  {
    name: "github-copilot",
    shouldRegister: async ({ cfg, hasAccounts }) =>
      !!cfg || hasAccounts || (await hasOAuthCredentials("github-copilot")),
    create: ({ providerConfig, accountConfig }) => {
      const merged = { ...(providerConfig?.headers ?? {}), ...(accountConfig?.headers ?? {}) };
      const headers = Object.keys(merged).length > 0 ? merged : undefined;
      const apiKey = accountConfig?.apiKey ?? providerConfig?.apiKey;
      return new CopilotProvider(apiKey, headers);
    },
  },
  makePiAiDescriptor("anthropic", async ({ cfg, hasAccounts }) =>
    !!cfg || hasAccounts || (await hasOAuthCredentials("anthropic")) || !!process.env["ANTHROPIC_API_KEY"]),
  makePiAiDescriptor("openai", async ({ cfg, hasAccounts }) =>
    !!cfg || hasAccounts || !!process.env["OPENAI_API_KEY"]),
  makePiAiDescriptor("openai-codex", async ({ cfg, hasAccounts }) =>
    !!cfg || hasAccounts || (await hasOAuthCredentials("openai-codex")) || !!process.env["OPENAI_CODEX_API_KEY"]),
  makePiAiDescriptor("opencode", async ({ cfg, hasAccounts }) =>
    !!cfg || hasAccounts || !!process.env["OPENCODE_API_KEY"]),
  makePiAiDescriptor("opencode-go", async ({ cfg, hasAccounts }) =>
    !!cfg || hasAccounts || !!process.env["OPENCODE_API_KEY"]),
  {
    name: "ollama",
    shouldRegister: async () => true,
    create: ({ providerConfig, accountConfig }) =>
      new OllamaProvider(
        accountConfig?.baseUrl ?? providerConfig?.baseUrl,
        providerConfig?.defaultContextWindow,
      ),
  },
  {
    name: "llamacpp",
    shouldRegister: async ({ cfg, hasAccounts }) =>
      !!cfg || hasAccounts || !!process.env["LLAMACPP_BASE_URL"],
    create: ({ providerConfig, accountConfig }) =>
      new LlamaCppProvider(
        accountConfig?.baseUrl ?? providerConfig?.baseUrl ?? process.env["LLAMACPP_BASE_URL"],
        providerConfig?.defaultContextWindow,
      ),
  },
  {
    name: "nvidia-nim",
    shouldRegister: async ({ cfg, hasAccounts }) =>
      !!cfg
      || hasAccounts
      || !!process.env["NVIDIA_API_KEY"]
      || !!process.env["NVIDIA_NIM_API_KEY"],
    create: ({ providerConfig, accountConfig }) =>
      new NvidiaNimProvider(
        accountConfig?.apiKey ?? providerConfig?.apiKey,
        accountConfig?.baseUrl ?? providerConfig?.baseUrl,
        providerConfig?.defaultContextWindow,
      ),
  },
] as const satisfies readonly ProviderDescriptor[];

type ProviderName = (typeof PROVIDER_DESCRIPTORS)[number]["name"];

const PROVIDER_DESCRIPTORS_BY_NAME: ReadonlyMap<ProviderName, ProviderDescriptor<ProviderName>> =
  new Map(
    PROVIDER_DESCRIPTORS.map((d) => [d.name, d as ProviderDescriptor<ProviderName>]),
  );

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(
    private readonly providerConfigs: Record<string, RuntimeProviderConfigLike>,
    private readonly credentialResolver: CredentialResolver,
  ) {}

  async initBaseProviders(): Promise<void> {
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      const cfg = this.providerConfigs[descriptor.name];
      const hasAccounts = Object.keys(cfg?.accounts ?? {}).length > 0;
      if (!(await descriptor.shouldRegister({ cfg, hasAccounts }))) continue;
      const provider = descriptor.create({ providerConfig: cfg, accountConfig: undefined });
      this.providers.set(descriptor.name, provider);
    }
  }

  hasDescriptor(name: string): boolean {
    return PROVIDER_DESCRIPTORS_BY_NAME.has(name as ProviderName);
  }

  get(name: string): ModelProvider | undefined {
    return this.providers.get(name);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  listBaseProviders(): string[] {
    return [...this.providers.keys()].filter((name) => !name.includes("#"));
  }

  entries(): IterableIterator<[string, ModelProvider]> {
    return this.providers.entries();
  }

  providerMapForTests(): Map<string, ModelProvider> {
    return this.providers;
  }

  getForRequest(providerName: string, request?: CredentialRequest): ModelProvider | undefined {
    const accountName = this.credentialResolver.resolveRequestedAccountName(providerName, request);
    if (!accountName) return this.providers.get(providerName);

    const key = `${providerName}#${accountName}`;
    const existing = this.providers.get(key);
    if (existing) return existing;

    const provider = this.createProvider(providerName, accountName);
    if (!provider) return this.providers.get(providerName);
    this.providers.set(key, provider);
    return provider;
  }

  private createProvider(providerName: string, accountName?: string): ModelProvider | undefined {
    const descriptor = PROVIDER_DESCRIPTORS_BY_NAME.get(providerName as ProviderName);
    if (!descriptor) return undefined;
    const accountConfig = accountName ? this.getAccountConfig(providerName, accountName) : undefined;
    const providerConfig = this.providerConfigs[providerName];
    return descriptor.create({ providerConfig, accountConfig });
  }

  private getAccountConfig(providerName: string, accountName: string): RuntimeProviderAccountLike | undefined {
    return this.providerConfigs[providerName]?.accounts?.[accountName];
  }
}
