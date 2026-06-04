import { getOAuthApiKey, getProfileByKey } from "../auth/index.js";
import type { RuntimeProviderAccountLike, RuntimeProviderConfigLike } from "../routing/resolver.js";
import { parseAccountRef } from "../routing/resolver.js";

export interface CredentialRequest {
  authProfileKey?: string;
  accountRef?: string;
}

export class CredentialResolver {
  constructor(private readonly providerConfigs: Record<string, RuntimeProviderConfigLike>) {}

  resolveRequestedAccountName(providerName: string, request?: CredentialRequest): string | undefined {
    if (request?.authProfileKey) return undefined;
    if (request?.accountRef) {
      const parsed = parseAccountRef(request.accountRef.includes(".") ? request.accountRef : `${providerName}.${request.accountRef}`);
      if (parsed.provider === providerName) return parsed.account;
    }

    const defaultAccount = this.providerConfigs[providerName]?.defaultAccount;
    if (defaultAccount && this.getAccountConfig(providerName, defaultAccount)) return defaultAccount;
    return undefined;
  }

  async resolveApiKey(providerName: string, request: CredentialRequest = {}): Promise<string | null> {
    const providerConfig = this.providerConfigs[providerName];
    const accountConfig = this.getRequestedAccountConfig(providerName, request);
    const mergedHeaders = {
      ...(providerConfig?.headers ?? {}),
      ...(accountConfig?.headers ?? {}),
    };
    const headers = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;

    if (request.authProfileKey) {
      const explicitProfile = await getProfileByKey(request.authProfileKey);
      if (explicitProfile?.provider === providerName) {
        const key = await getOAuthApiKey(providerName, { profileKey: request.authProfileKey, headers });
        if (key) return key;
      }
    }

    if (accountConfig?.authProfile) {
      const profiledKey = await getOAuthApiKey(providerName, { profileKey: accountConfig.authProfile, headers });
      if (profiledKey) return profiledKey;
    }

    if (accountConfig?.apiKey) return accountConfig.apiKey;
    if (providerConfig?.apiKey) return providerConfig.apiKey;

    return getOAuthApiKey(providerName, { headers });
  }

  private getRequestedAccountConfig(providerName: string, request?: CredentialRequest): RuntimeProviderAccountLike | undefined {
    const accountName = this.resolveRequestedAccountName(providerName, request);
    return accountName ? this.getAccountConfig(providerName, accountName) : undefined;
  }

  private getAccountConfig(providerName: string, accountName: string): RuntimeProviderAccountLike | undefined {
    return this.providerConfigs[providerName]?.accounts?.[accountName];
  }
}
