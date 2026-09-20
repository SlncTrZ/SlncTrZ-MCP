/** Owner-only foundation. Callers MUST authenticate the Owner before invoking mutations. */
import type { OAuthGrantStore } from "./oauth-grant-store.js";
import type { SurfaceProfile } from "./connection-profile.js";

export class OwnerConnectionService {
  constructor(
    private readonly store: OAuthGrantStore,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)
  ) {}
  /** Active grants only; expired/revoked grants are pruned, no token values or hashes. */
  listConnections() {
    return this.store.listConnections(this.now());
  }
  setGrantProfile(grantId: string, profile: SurfaceProfile): void {
    this.store.setGrantProfile(grantId, profile, this.now());
  }
  setClientDefault(clientId: string, profile: SurfaceProfile): void {
    this.store.setClientDefault(clientId, profile);
  }
  getClientDefault(clientId: string): SurfaceProfile | undefined {
    return this.store.getClientDefault(clientId);
  }
  revokeGrant(grantId: string): boolean {
    return this.store.revokeGrant(grantId);
  }
}
