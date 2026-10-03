/** Sample data for the dev gallery (no real values, no secrets). */
import type { FlowStep } from "@/ui/flow";

export const sampleCode = `import { useQuery } from "@tanstack/react-query";

// Etkin görevleri getir ve kare başına grupla.
export function useActiveTasks(workspaceId: string) {
  return useQuery({
    queryKey: ["tasks", workspaceId, "active"],
    queryFn: () => api.get<Task[]>("/tasks", { workspace_id: workspaceId }),
    staleTime: 5_000,
  });
}

const MAX_PARALLEL = 3;
`;

export const diffOriginal = `export function limitTone(percent: number) {
  if (percent >= 90) return "critical";
  if (percent >= 80) return "warning";
  return "ok";
}

export function clamp(p: number) {
  return Math.min(100, Math.max(0, p));
}
`;

export const diffModified = `export function limitTone(percent: number, status?: Status) {
  const p = clamp(percent);
  if (status === "exhausted" || p >= 90) return "critical";
  if (p >= 70) return "warning";
  return "ok";
}

export function clamp(p: number) {
  if (!Number.isFinite(p)) return 0;
  return Math.min(100, Math.max(0, p));
}
`;

export const sampleMarkdown = `## Karar: Limit çubukları

Üst çubukta her sağlayıcı için **iki ince çubuk** gösterilir: *5 saat* ve *haftalık*.
Renk \`%70\` ve \`%90\` eşiklerinde değişir. Ayrıntı için [şartname](https://example.com/sartname).

- Kaynak: CLI olayı veya sorgu
- Sıfırlanma zamanı geri sayımla gösterilir
  - Boştayken son bilinen değer
- [x] Tasarım onaylandı
- [ ] Menü çubuğu halkaları

> Kanıtsız iş tamamlanmış sayılmaz.

| Pencere | Kullanım | Durum |
|:--|--:|:-:|
| 5 saat | %42 | iyi |
| Haftalık | %91 | kritik |

\`\`\`ts
const tone = limitTone(91); // "critical"
\`\`\`
`;

const ESC = "\x1b";

export const sampleLog: string[] = [
  `${ESC}[2m$ pnpm test --run${ESC}[0m`,
  "",
  ` ${ESC}[32m✓${ESC}[0m src/ui/limits.test.ts ${ESC}[2m(6 tests)${ESC}[0m ${ESC}[33m12ms${ESC}[0m`,
  ` ${ESC}[32m✓${ESC}[0m src/lib/fuzzy.test.ts ${ESC}[2m(9 tests)${ESC}[0m ${ESC}[33m8ms${ESC}[0m`,
  ` ${ESC}[31m✗${ESC}[0m src/ui/log/ansi.test.ts ${ESC}[2m(4 tests | 1 failed)${ESC}[0m`,
  `   ${ESC}[1;31mAssertionError${ESC}[0m: expected ${ESC}[32m"bold"${ESC}[0m to be ${ESC}[31m"dim"${ESC}[0m`,
  `   ${ESC}[36m❯${ESC}[0m src/ui/log/ansi.test.ts:${ESC}[33m42${ESC}[0m:${ESC}[33m7${ESC}[0m`,
  "",
  ` ${ESC}[1mTest Files${ESC}[0m  ${ESC}[1;31m1 failed${ESC}[0m | ${ESC}[1;32m2 passed${ESC}[0m (3)`,
  `      ${ESC}[1mTests${ESC}[0m  ${ESC}[1;31m1 failed${ESC}[0m | ${ESC}[1;32m18 passed${ESC}[0m (19)`,
  `${ESC}[38;5;208m256 renk${ESC}[0m · ${ESC}[38;2;120;160;255mtruecolor${ESC}[0m · ${ESC}[7m ters ${ESC}[0m · ${ESC}[4malt çizgi${ESC}[0m`,
];

export const streamLines: string[] = [
  `${ESC}[36m→${ESC}[0m worktree oluşturuluyor: aistudio/task-142/claude-1`,
  `${ESC}[2mgit worktree add -b aistudio/task-142/claude-1${ESC}[0m`,
  "src/ui/LimitBar.tsx okunuyor",
  `${ESC}[33m~${ESC}[0m src/ui/LimitBar.tsx düzenlendi (+12 −3)`,
  `${ESC}[2m$ pnpm typecheck${ESC}[0m`,
  `${ESC}[32m✓${ESC}[0m tip denetimi geçti`,
  `${ESC}[2m$ pnpm test${ESC}[0m`,
  `${ESC}[32m✓${ESC}[0m 132 test geçti`,
  `${ESC}[35m⇢${ESC}[0m inceleme için Codex'e devrediliyor`,
];

export const modeOptions = [
  { value: "tek", label: "Tek", hint: "Tek ajan: yazar → build/test → son onay" },
  { value: "ikili", label: "İkili", hint: "Biri yazar, diğer model inceler" },
  { value: "yaris", label: "Yarış", hint: "Aynı iş paralel yapılır, sonuçlar karşılaştırılır" },
  { value: "hat", label: "Hat", hint: "Planlayıcı → geliştirici → inceleyen → test eden" },
  { value: "kurul", label: "Kurul", hint: "Bağımsız görüşler, karşı tez, tek karar belgesi" },
];

export const flowSteps: FlowStep[] = [
  { id: "plan", label: "Plan", kind: "agent", provider: "claude", status: "done" },
  { id: "plan-gate", label: "Plan onayı", kind: "gate", status: "done" },
  { id: "dev", label: "Geliştirici", kind: "agent", provider: "claude", status: "active" },
  { id: "build", label: "Build/test", kind: "gate", status: "pending" },
  { id: "review", label: "İnceleme", kind: "agent", provider: "codex", status: "pending" },
  { id: "final", label: "Son onay", kind: "gate", status: "pending" },
];

export function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3_600_000).toISOString();
}
