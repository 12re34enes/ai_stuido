import { ApiError } from "@/lib/api";

/** Turkish, user-facing message for any thrown error (API errors already carry one). */
export function errorMessage(err: unknown, fallback = "Beklenmeyen bir hata oluştu."): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
