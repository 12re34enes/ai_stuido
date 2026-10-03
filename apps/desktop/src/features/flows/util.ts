/** Small shared helpers. */
import { ApiError } from "@/lib/api";

/** User-facing message of an unknown error (API errors carry Turkish messages). */
export function errorText(e: unknown, fallback = "Beklenmeyen bir hata oluştu."): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}
