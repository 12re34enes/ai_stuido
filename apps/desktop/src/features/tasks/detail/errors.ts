/** Turkish, user-facing text for errors from studiod. */
import { common } from "@/i18n/common";
import { ApiError } from "@/lib/api";
import { isUnreachable } from "@/lib/connection";

export function errorMessage(err: unknown): string {
  if (isUnreachable(err)) return common.backendDown;
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}
