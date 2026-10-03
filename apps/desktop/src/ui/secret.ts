/**
 * What the form will do with a secret on save:
 * - keep: send nothing (stored value stays in the Keychain, or nothing is set)
 * - set: send `value` once
 * - clear: send an empty value (the backend deletes the Keychain item)
 */
export type SecretDraft = { action: "keep" } | { action: "set"; value: string } | { action: "clear" };

export const KEEP: SecretDraft = { action: "keep" };

/** API value for a draft: undefined = omit the field, "" = delete, string = new value. */
export function secretPayload(d: SecretDraft): string | undefined {
  if (d.action === "set") return d.value;
  if (d.action === "clear") return "";
  return undefined;
}
