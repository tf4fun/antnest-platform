import type { CurrentAccount } from "./types";
import type { ResourceState } from "./resource-state";

export type AccountPresentation = {
  primary: string;
  secondary: string;
  organizationName: string;
  organizationSlug: string;
  localPasswordAvailable: boolean;
  retryable: boolean;
};

export function accountPresentation(state: ResourceState<CurrentAccount>): AccountPresentation {
  if (state.status === "ready") {
    return {
      primary: state.data.display_name,
      secondary: state.data.email,
      organizationName: state.data.organization_name,
      organizationSlug: state.data.organization_slug,
      localPasswordAvailable: state.data.local_password_available,
      retryable: false,
    };
  }
  return {
    primary: "Signed-in account",
    secondary: state.status === "loading" ? "Loading account profile" : "Account profile unavailable",
    organizationName: "Organization",
    organizationSlug: state.status === "loading" ? "Loading profile" : "Profile unavailable",
    localPasswordAvailable: false,
    retryable: state.status === "error" && state.failure.retryable,
  };
}
