import { clsx, type ClassValue } from "clsx";

/** Join class names conditionally. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
