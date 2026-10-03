/** Turkish message for a failed request (the API's own message when it has one). */
import { common } from "@/i18n/common";
import { ApiError } from "@/lib/api";
import { isUnreachable } from "@/lib/connection";

export function errorMessage(err: unknown): string | undefined {
  if (isUnreachable(err)) return common.backendDown;
  if (err instanceof ApiError) return err.message;
  return undefined;
}
