// Command substitution preserves find/sha256sum failure before sorting. The
// caller normalizes the final newline just like the historical saved manifest.
export const workspaceManifestCommand = `cd /workspace || exit
manifest=$(find . -type f -exec sha256sum '{}' +) || exit
printf '%s\\n' "$manifest" | sort`;
