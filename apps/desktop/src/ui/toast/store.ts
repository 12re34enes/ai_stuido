/**
 * Toasts: transient, non-blocking notices. Rendered by <Toaster/> (mounted once by the shell).
 *
 *   toast.success("Onay verildi");
 *   toast({ title: "Bağlantı koptu", description: "…", tone: "danger", action: { label: "Tekrar dene", onClick } });
 */
import { create } from "zustand";

export type ToastTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface ToastOptions {
  /** Reusing an id updates the existing toast instead of stacking a new one. */
  id?: string;
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss; `Infinity` keeps it until closed. Default 5000 (danger 8000). */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

export interface ToastItem extends Required<Pick<ToastOptions, "id" | "title" | "tone" | "duration">> {
  description?: string;
  action?: ToastOptions["action"];
  createdAt: number;
}

/** Older toasts beyond this are dropped from the store. */
export const MAX_TOASTS = 5;

interface ToastState {
  toasts: ToastItem[];
  add: (opts: ToastOptions) => string;
  dismiss: (id?: string) => void;
}

let seq = 0;

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  add: (opts) => {
    const id = opts.id ?? `t${++seq}`;
    const tone = opts.tone ?? "neutral";
    const item: ToastItem = {
      id,
      title: opts.title,
      description: opts.description,
      tone,
      duration: opts.duration ?? (tone === "danger" ? 8000 : 5000),
      action: opts.action,
      createdAt: Date.now(),
    };
    const existing = get().toasts.some((t) => t.id === id);
    set((s) => ({
      toasts: existing
        ? s.toasts.map((t) => (t.id === id ? item : t))
        : [...s.toasts, item].slice(-MAX_TOASTS),
    }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: id === undefined ? [] : s.toasts.filter((t) => t.id !== id) })),
}));

type ToastFn = ((opts: ToastOptions) => string) & {
  success: (title: string, opts?: Omit<ToastOptions, "title" | "tone">) => string;
  error: (title: string, opts?: Omit<ToastOptions, "title" | "tone">) => string;
  warning: (title: string, opts?: Omit<ToastOptions, "title" | "tone">) => string;
  info: (title: string, opts?: Omit<ToastOptions, "title" | "tone">) => string;
  dismiss: (id?: string) => void;
};

const add = (opts: ToastOptions) => useToasts.getState().add(opts);

export const toast: ToastFn = Object.assign(add, {
  success: (title: string, opts?: Omit<ToastOptions, "title" | "tone">) => add({ ...opts, title, tone: "success" }),
  error: (title: string, opts?: Omit<ToastOptions, "title" | "tone">) => add({ ...opts, title, tone: "danger" }),
  warning: (title: string, opts?: Omit<ToastOptions, "title" | "tone">) => add({ ...opts, title, tone: "warning" }),
  info: (title: string, opts?: Omit<ToastOptions, "title" | "tone">) => add({ ...opts, title, tone: "info" }),
  dismiss: (id?: string) => useToasts.getState().dismiss(id),
});
