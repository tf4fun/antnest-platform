import type { ProviderDestinationOptions } from "../../src/adapters/model/destination-policy.js";

// Only for tests that inject a synthetic fetch. No Internet DNS or socket is
// used; URL/address policy remains enabled. Real-network tests opt in explicitly.
export const syntheticProviderDestination: ProviderDestinationOptions = {
  resolve: () => Promise.resolve(["8.8.8.8"]),
};
