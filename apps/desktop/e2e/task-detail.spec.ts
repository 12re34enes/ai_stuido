/**
 * Task detail + run replay against the shared mocked studiod (e2e/mock.ts) plus this spec's own
 * engine / gitops / limits routes. Writes light and dark screenshots to test-results/screens/.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

import { approval, installMockApi, NOW, settle, type MockApi } from "./mock";

const shot = (name: string) => `test-results/screens/${name}.png`;
const mod = process.platform === "darwin" ? "Meta" : "Control";
const iso = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

// ----------------------------------------------------------------------------- fixtures

type Json = Record<string, unknown>;

const duoGraph = {
  nodes: [
    { id: "dev", label: "Yazar (Claude)", config: { kind: "agent", provider: "claude", role: "writer" } },
    { id: "boundary", label: "Sınır denetimi", config: { kind: "gate", gate: "boundary_check" } },
    { id: "build", label: "Build/test kanıtı", config: { kind: "gate", gate: "build_test" } },
    { id: "review", label: "Çapraz inceleme (Codex)", config: { kind: "gate", gate: "cross_review" } },
    { id: "final", label: "Son onay", config: { kind: "gate", gate: "user_final" } },
  ],
  edges: [
    { id: "e_dev_boundary", source: "dev", target: "boundary", condition: "default" },
    { id: "e_boundary_build", source: "boundary", target: "build", condition: "default" },
    { id: "e_build_review", source: "build", target: "review", condition: "default" },
    { id: "e_review_final", source: "review", target: "final", condition: "default" },
    { id: "e_boundary_dev_failed", source: "boundary", target: "dev", condition: "failed" },
    { id: "e_build_dev_failed", source: "build", target: "dev", condition: "failed" },
    { id: "e_review_dev_failed", source: "review", target: "dev", condition: "failed" },
    { id: "e_final_dev_failed", source: "final", target: "dev", condition: "failed" },
  ],
};

function nodeRun(runId: string, nodeId: string, attempt: number, status: string, start: number, end: number | null, over: Json = {}): Json {
  return {
    id: `nr_${runId}_${nodeId}_${attempt}`,
    run_id: runId,
    node_id: nodeId,
    status,
    attempt,
    session_ids: [],
    worktree_ids: [],
    output: null,
    data: null,
    error: null,
    started_at: iso(start),
    finished_at: end === null ? null : iso(end),
    ...over,
  };
}

const devOutput = [
  "Limit çubuklarını üst çubuğa ekledim.",
  "",
  "## Değişiklikler",
  "- `LimitsWidget` her sağlayıcı için iki ince çubuk gösteriyor (5 saat, haftalık).",
  "- Renk **%70**'te sarıya, **%90**'da kırmızıya dönüyor; `limitTone` artık durumu da hesaba katıyor.",
  "- Sıfırlanma geri sayımı açılır kartta canlı akıyor.",
  "",
  "Testleri `limits.test.ts` içinde güncelledim; build/test kapısının bulduğu sınır değeri hatasını düzelttim.",
].join("\n");

const failingTest = [
  "\x1b[2m> vitest run\x1b[0m",
  "",
  " \x1b[32m✓\x1b[0m src/ui/limits.test.ts > clampPercent \x1b[2m(3)\x1b[0m",
  " \x1b[31m✗\x1b[0m src/ui/limits.test.ts > limitTone > turns amber at 70%",
  "   \x1b[31mAssertionError: expected 'ok' to be 'warning'\x1b[0m",
  "     ❯ src/ui/limits.test.ts:24:32",
  "",
  " Test Files  \x1b[31m1 failed\x1b[0m | 11 passed (12)",
  "      Tests  \x1b[31m1 failed\x1b[0m | 146 passed (147)",
].join("\n");

function buildEvidence(failed: boolean): Json {
  const cmd = (name: string, command: string, code: number, ms: number, out: string) => ({ repo_id: "repo_web", repo: "odeme-web", worktree_id: "wt_1", name, command, exit_code: code, duration_ms: ms, output_tail: out });
  return {
    commands: [
      cmd("lint", "pnpm lint", 0, 8_400, "> eslint .\n✔ No problems"),
      cmd("typecheck", "pnpm typecheck", 0, 19_200, "> tsc -b --noEmit"),
      failed ? cmd("test", "pnpm test", 1, 41_800, failingTest) : cmd("test", "pnpm test", 0, 39_100, " Test Files  12 passed (12)\n      Tests  147 passed (147)"),
      cmd("build", "pnpm build", 0, 52_600, "vite v8.3.2 building for production...\n✓ 1204 modules transformed.\n✓ built in 9.82s"),
    ],
    runner: "studiod",
    note: "Komutları ajan değil studiod çalıştırdı.",
  };
}

const boundaryEvidence = { changed_files: { "odeme-web": ["apps/web/src/shell/LimitsWidget.tsx", "apps/web/src/ui/LimitBar.tsx", "apps/web/src/ui/limits.test.ts"] }, commands_checked: 12, rules: { forbidden_paths: [".env*", "infra/**"], readonly_paths: ["docs/**"], denied_commands: [] }, violations: [] };

function gate(runId: string, nodeId: string, kind: string, attempt: number, status: string, at: number, summary: string, evidence: Json, decided = "studiod"): Json {
  return { id: `g_${runId}_${nodeId}_${attempt}`, run_id: runId, node_run_id: `nr_${runId}_${nodeId}_${attempt}`, node_id: nodeId, kind, status, attempt, target_node_id: "dev", summary, evidence, decided_by: decided, created_at: iso(at) };
}

const reviewEvidence = {
  author_node_id: "dev",
  author_provider: "claude",
  reviewer_provider: "codex",
  reviewer_model: "gpt-5.5-codex",
  verdict: "pass",
  summary: "Değişiklik planla uyumlu; eşik mantığı doğru ve testler kapsamlı. Birkaç küçük iyileştirme önerisi var.",
  findings: [
    { severity: "medium", file: "apps/web/src/shell/LimitsWidget.tsx", line: 48, message: "Geri sayım her saniye tüm çubukları yeniden çiziyor; ortak `useNow` ticker'ı kullanılabilir." },
    { severity: "low", file: "apps/web/src/ui/LimitBar.tsx", line: 12, message: "`aria-valuetext` yüzdeyi Türkçe biçimde vermeli (%70)." },
    { severity: "low", file: null, line: null, message: "Haftalık (Opus) penceresi için ayrı etiket düşünülebilir." },
  ],
  counts: { critical: 0, high: 0, medium: 1, low: 2 },
  blocking_severities: ["critical", "high"],
  blocking_count: 0,
};

const patchWidget = [
  "diff --git a/apps/web/src/shell/LimitsWidget.tsx b/apps/web/src/shell/LimitsWidget.tsx",
  "--- a/apps/web/src/shell/LimitsWidget.tsx",
  "+++ b/apps/web/src/shell/LimitsWidget.tsx",
  "@@ -12,14 +12,22 @@ import { LimitBar } from \"@/ui\";",
  " export function LimitsWidget() {",
  "   const { data: windows = [] } = useLimits();",
  "-  const groups = windows.filter((w) => w.window === \"five_hour\");",
  "+  const groups = groupLimits(windows);",
  "   return (",
  "     <div className=\"flex items-center gap-3\">",
  "-      {groups.map((w) => (",
  "-        <LimitBar key={w.provider} value={w.used_percent} size=\"mini\" />",
  "+      {groups.map((g) => (",
  "+        <div key={g.provider} className=\"flex flex-col gap-[3px]\">",
  "+          {g.windows.slice(0, 2).map((w) => (",
  "+            <LimitBar key={w.window} value={w.used_percent} status={w.status} label={w.label} size=\"mini\" />",
  "+          ))}",
  "+        </div>",
  "       ))}",
  "     </div>",
  "   );",
  " }",
  "",
].join("\n");

const patchBar = [
  "@@ -18,9 +18,12 @@ export function LimitBar({ value, status, label, resetsAt, size = \"md\" }: LimitBarProps) {",
  "   const v = clampPercent(value);",
  "-  const tone = v >= 90 ? \"critical\" : v >= 80 ? \"warning\" : \"ok\";",
  "+  const tone = limitTone(v, status);",
  "   const bar = (",
  "     <div",
  "       role=\"meter\"",
  "+      aria-label={label}",
  "+      aria-valuetext={formatPercent(v)}",
  "       aria-valuenow={Math.round(v)}",
  "",
].join("\n");

const patchTest = [
  "@@ -0,0 +1,8 @@",
  "+import { limitTone } from \"./limits\";",
  "+",
  "+describe(\"limitTone\", () => {",
  "+  it(\"turns amber at 70% and red at 90%\", () => {",
  "+    expect(limitTone(69)).toBe(\"ok\");",
  "+    expect(limitTone(70)).toBe(\"warning\");",
  "+    expect(limitTone(90)).toBe(\"critical\");",
  "+  });",
  "",
].join("\n");

interface Scenario {
  tasks: Record<string, Json>;
  runs: Record<string, Json>;
  gates: Record<string, Json[]>;
  evidence: Record<string, Json[]>;
  checkpoints: Record<string, Json[]>;
  sessions: Record<string, Json[]>;
  worktrees: Record<string, Json[]>;
  timelines: Record<string, Json>;
  posts: { path: string; body: unknown }[];
  failTask: { status: number; times: number } | null;
}

function session(id: string, over: Json): Json {
  return {
    id,
    workspace_id: "ws_1",
    provider: "claude",
    profile_id: null,
    native_id: null,
    location: { kind: "local", host_id: null },
    cwd: "/Users/demo/src/odeme-web",
    worktree_id: "wt_1",
    task_id: "task_142",
    run_id: "run_9",
    node_id: "dev",
    label: "Yazar (Claude)",
    role: "writer",
    model: "claude-opus-5-5",
    state: "done",
    origin: "created",
    title: null,
    created_at: iso(-38),
    updated_at: iso(-12),
    last_usage: { input_tokens: 140_200, output_tokens: 20_120, context_used: 96_000, context_window: 200_000 },
    live: false,
    ...over,
  };
}

function scenario(): Scenario {
  const run9Nodes = [
    nodeRun("run_9", "dev", 1, "passed", -38, -26, { output: "İlk sürüm hazır.", session_ids: ["ses_dev"] }),
    nodeRun("run_9", "boundary", 1, "passed", -26, -25.9),
    nodeRun("run_9", "build", 1, "failed", -25.9, -24, { error: "1/4 komut başarısız: odeme-web:test" }),
    nodeRun("run_9", "dev", 2, "passed", -23, -12, { output: devOutput, session_ids: ["ses_dev"] }),
    nodeRun("run_9", "boundary", 2, "passed", -12, -11.9),
    nodeRun("run_9", "build", 2, "passed", -11.9, -9.6),
    nodeRun("run_9", "review", 1, "running", -9.5, null, { session_ids: ["ses_rev"] }),
  ];
  const run9 = { id: "run_9", task_id: "task_142", workspace_id: "ws_1", graph: duoGraph, status: "running", nodes: run9Nodes, started_at: iso(-38), finished_at: null };

  const run7Nodes = [
    nodeRun("run_7", "dev", 1, "passed", -300, -290, { output: devOutput }),
    nodeRun("run_7", "boundary", 1, "passed", -290, -289.9),
    nodeRun("run_7", "build", 1, "passed", -289.9, -288),
    nodeRun("run_7", "review", 1, "passed", -288, -282, { output: "3 bulgu, engelleyici yok." }),
    nodeRun("run_7", "final", 1, "passed", -282, -270, { output: "**Görev:** Kota uyarı e-postası" }),
  ];
  const run7 = { id: "run_7", task_id: "task_141", workspace_id: "ws_1", graph: duoGraph, status: "completed", nodes: run7Nodes, started_at: iso(-300), finished_at: iso(-270) };

  const task = (id: string, over: Json): Json => ({
    id,
    workspace_id: "ws_1",
    title: "Limit çubuklarını üst çubuğa ekle",
    prompt:
      "Üst çubukta her sağlayıcı için iki ince limit çubuğu göster (5 saat ve haftalık). Renk %70'te sarıya, %90'da kırmızıya dönsün. Tıklanınca döküm ve sıfırlanmaya geri sayım açılsın. Mevcut LimitBar bileşenini kullan, tasarım belirteçlerinin dışına çıkma ve erişilebilirlik etiketlerini Türkçe ver.",
    mode: "duo",
    flow_id: null,
    studio_id: null,
    repo_ids: ["repo_web"],
    base_ref: "main",
    inputs: {},
    budget: { max_five_hour_percent: 20, max_weekly_percent: 5 },
    priority: 0,
    status: "running",
    scheduled_at: null,
    source: "user",
    source_ref: null,
    current_run_id: "run_9",
    quality_score: null,
    created_at: iso(-40),
    updated_at: iso(-1),
    ...over,
  });

  const quality = {
    score: 86,
    components: [
      { key: "gates_first_pass", label: "Kapıların ilk denemede geçmesi", weight: 30, value: 1, detail: "4/4 kapı ilk denemede geçti.", raw: {} },
      { key: "review", label: "İnceleme bulgularının ağırlığı", weight: 25, value: 0.93, detail: "1 orta, 2 düşük bulgu.", raw: {} },
      { key: "tests", label: "Build/test komutları", weight: 25, value: 1, detail: "4/4 komut geçti.", raw: {} },
      { key: "rework", label: "Tekrar turları", weight: 10, value: 1, detail: "Tekrar turu yok.", raw: {} },
      { key: "user_rating", label: "Kullanıcı puanı", weight: 10, value: 0.75, detail: "4/5 yıldız.", raw: {} },
    ],
    formula: "Puan = 100 × Σ(ağırlık × değer) / Σ(ağırlık). Uygulanamayan bileşenler hesaba katılmaz, ağırlıkları diğerlerine dağıtılır.",
    run_id: "run_7",
    computed_at: iso(-270),
  };

  const t = (sec: number) => new Date(NOW.getTime() - 300 * 60_000 + sec * 1000).toISOString();
  let id = 1000;
  const ev = (sec: number, type: string, payload: Json = {}, extra: Json = {}) => ({ id: ++id, ts: t(sec), type, severity: "info", actor: "system", workspace_id: "ws_1", task_id: "task_141", run_id: "run_7", session_id: null, payload, ephemeral: false, prev_hash: "", hash: "", ...extra });
  const nrid = (n: string, a = 1) => `nr_run_7_${n}_${a}`;
  const timelineEvents = [
    ev(0, "run.started", { run_id: "run_7", mode: "duo" }),
    ev(1, "node.started", { node_id: "dev", node_run_id: nrid("dev"), label: "Yazar (Claude)", kind: "agent", attempt: 1 }),
    ev(2, "node.session", { node_id: "dev", label: "Yazar (Claude)", provider: "claude", model: "claude-opus-5-5", role: "writer" }, { session_id: "ses_d7" }),
    ev(3, "agent.status", { state: "thinking" }, { session_id: "ses_d7" }),
    ev(9, "agent.tool.call", { tool: "Read", kind: "file_read", summary: "src/ui/LimitBar.tsx okundu" }, { session_id: "ses_d7" }),
    ev(14, "agent.status", { state: "running_tool" }, { session_id: "ses_d7" }),
    ev(20, "agent.tool.call", { tool: "Edit", kind: "file_edit", summary: "src/shell/LimitsWidget.tsx düzenlendi" }, { session_id: "ses_d7" }),
    ev(31, "agent.tool.call", { tool: "Bash", kind: "command", summary: "pnpm test limits" }, { session_id: "ses_d7" }),
    ev(44, "agent.message", { message_id: "m1", text: "Çubuklar hazır; eşikler %70 ve %90." }, { session_id: "ses_d7" }),
    ev(46, "agent.status", { state: "done" }, { session_id: "ses_d7" }),
    ev(47, "node.completed", { node_id: "dev", node_run_id: nrid("dev"), label: "Yazar (Claude)", status: "passed", output_preview: "Limit çubuklarını üst çubuğa ekledim." }),
    ev(47, "checkpoint.created", { checkpoint_id: "ck_71", node_id: "dev", label: "Yazar (Claude) sonrası" }),
    ev(47, "run.edge", { edge_id: "e_dev_boundary", source: "dev", target: "boundary" }),
    ev(48, "node.started", { node_id: "boundary", node_run_id: nrid("boundary"), label: "Sınır denetimi", attempt: 1 }),
    ev(49, "gate.passed", { node_id: "boundary", gate: "boundary_check", summary: "3 değişen dosya ve 12 komut denetlendi; sınır ihlali yok.", attempt: 1 }),
    ev(49, "node.completed", { node_id: "boundary", node_run_id: nrid("boundary"), status: "passed" }),
    ev(49, "run.edge", { edge_id: "e_boundary_build", source: "boundary", target: "build" }),
    ev(50, "node.started", { node_id: "build", node_run_id: nrid("build"), label: "Build/test kanıtı", attempt: 1 }),
    ev(2050, "gate.passed", { node_id: "build", gate: "build_test", summary: "4 komut başarıyla çalıştı.", attempt: 1 }),
    ev(2050, "node.completed", { node_id: "build", node_run_id: nrid("build"), status: "passed" }),
    ev(2050, "run.edge", { edge_id: "e_build_review", source: "build", target: "review" }),
    ev(2051, "node.started", { node_id: "review", node_run_id: nrid("review"), label: "Çapraz inceleme (Codex)", attempt: 1 }),
    ev(2052, "node.session", { node_id: "review", label: "Çapraz inceleme (Codex) · inceleyen", provider: "codex", model: "gpt-5.5-codex", role: "reviewer" }, { session_id: "ses_r7" }),
    ev(2053, "agent.status", { state: "running_tool" }, { session_id: "ses_r7" }),
    ev(2060, "agent.tool.call", { tool: "shell", kind: "command", summary: "git diff --stat" }, { session_id: "ses_r7" }),
    ev(2071, "agent.status", { state: "done" }, { session_id: "ses_r7" }),
    ev(2072, "gate.passed", { node_id: "review", gate: "cross_review", summary: "3 bulgu, engelleyici yok.", attempt: 1, decided_by: "agent:codex" }),
    ev(2072, "node.completed", { node_id: "review", node_run_id: nrid("review"), status: "passed" }),
    ev(2072, "run.edge", { edge_id: "e_review_final", source: "review", target: "final" }),
    ev(2073, "node.started", { node_id: "final", node_run_id: nrid("final"), label: "Son onay", attempt: 1 }),
    ev(2073, "approval.requested", { approval_id: "apr_71", kind: "final", title: "Son onay: Kota uyarı e-postası" }),
    ev(2074, "node.waiting", { node_id: "final", node_run_id: nrid("final"), reason: "Son onay bekleniyor", wait_kind: "approval" }),
    ev(2090, "approval.decided", { approval_id: "apr_71", kind: "final", status: "approved", decided_by: "user" }),
    ev(2090, "node.running", { node_id: "final", node_run_id: nrid("final") }),
    ev(2091, "gate.passed", { node_id: "final", gate: "user_final", summary: "Kullanıcı son onayı verdi.", attempt: 1, decided_by: "user" }),
    ev(2091, "node.completed", { node_id: "final", node_run_id: nrid("final"), status: "passed" }),
    ev(2092, "run.completed", { status: "completed" }),
  ];

  return {
    tasks: {
      task_142: { task: task("task_142", {}), runs: [{ id: "run_9", status: "running", error: null, started_at: iso(-38), finished_at: null }], current_run: run9, quality: null, rating: null, rating_note: null, error: null, hold_until: null, hold_reason: null, start_on_reset: false, has_explicit_graph: false },
      task_141: {
        task: task("task_141", { title: "Kota uyarı e-postası", status: "completed", current_run_id: "run_7", quality_score: 86, created_at: iso(-310) }),
        runs: [
          { id: "run_7", status: "completed", error: null, started_at: iso(-300), finished_at: iso(-270) },
          { id: "run_6", status: "failed", error: "Tur sınırı aşıldı (3/3).", started_at: iso(-420), finished_at: iso(-380) },
        ],
        current_run: run7,
        quality,
        rating: 4,
        rating_note: null,
        error: null,
        hold_until: null,
        hold_reason: null,
        start_on_reset: false,
        has_explicit_graph: false,
      },
      task_150: {
        task: task("task_150", { title: "Ödeme formuna 3D Secure ekle", status: "draft", current_run_id: null, mode: "duo", created_at: iso(-5) }),
        runs: [],
        current_run: null,
        quality: null,
        rating: null,
        rating_note: null,
        error: null,
        hold_until: null,
        hold_reason: null,
        start_on_reset: false,
        has_explicit_graph: false,
      },
    },
    runs: { run_9: run9, run_7: run7 },
    gates: {
      run_9: [
        gate("run_9", "boundary", "boundary_check", 1, "passed", -25.9, "3 değişen dosya ve 12 komut denetlendi; sınır ihlali yok.", boundaryEvidence),
        gate("run_9", "build", "build_test", 1, "failed", -24, "1/4 komut başarısız: odeme-web:test", buildEvidence(true)),
        gate("run_9", "boundary", "boundary_check", 2, "passed", -11.9, "3 değişen dosya ve 12 komut denetlendi; sınır ihlali yok.", boundaryEvidence),
        gate("run_9", "build", "build_test", 2, "passed", -9.6, "4 komut başarıyla çalıştı.", buildEvidence(false)),
      ],
      run_7: [
        gate("run_7", "boundary", "boundary_check", 1, "passed", -289.9, "3 değişen dosya ve 12 komut denetlendi; sınır ihlali yok.", boundaryEvidence),
        gate("run_7", "build", "build_test", 1, "passed", -288, "4 komut başarıyla çalıştı.", buildEvidence(false)),
        gate("run_7", "review", "cross_review", 1, "passed", -282, "3 bulgu, engelleyici yok.", reviewEvidence, "agent:codex"),
        gate("run_7", "final", "user_final", 1, "passed", -270, "Kullanıcı son onayı verdi.", { approval_id: "apr_71", status: "approved", note: "Güzel olmuş, birleştirelim." }, "user"),
      ],
    },
    evidence: {
      run_9: [{ id: "ev_1", workspace_id: "ws_1", task_id: "task_142", run_id: "run_9", node_run_id: "nr_run_9_dev_2", node_id: "dev", source: "agent", kind: "note", title: "Ekran görüntüsü notu", content: "Açık ve koyu temada çubuklar kontrol edildi.", data: null, created_by: "agent:ses_dev", created_at: iso(-12.5), label: "Ajan tarafından eklendi — kapı kanıtı değildir" }],
      run_7: [],
    },
    checkpoints: {
      run_9: [
        { id: "ck_1", run_id: "run_9", node_id: "dev", node_run_id: "nr_run_9_dev_1", label: "Yazar (Claude) sonrası", gitops_checkpoint_id: "gck_1", refs: { wt_1: "a1b2c3d" }, memory_commit: "9f8e7d6c5b4a", created_at: iso(-26) },
        { id: "ck_2", run_id: "run_9", node_id: "dev", node_run_id: "nr_run_9_dev_2", label: "Yazar (Claude) sonrası", gitops_checkpoint_id: "gck_2", refs: { wt_1: "d4e5f6a" }, memory_commit: "9f8e7d6c5b4a", created_at: iso(-12) },
        { id: "ck_3", run_id: "run_9", node_id: "build", node_run_id: "nr_run_9_build_2", label: "Build/test kanıtı sonrası", gitops_checkpoint_id: "gck_3", refs: { wt_1: "d4e5f6a" }, memory_commit: null, created_at: iso(-9.6) },
      ],
      run_7: [],
    },
    sessions: {
      run_9: [
        session("ses_dev", {}),
        session("ses_rev", { provider: "codex", node_id: "review", label: "Çapraz inceleme (Codex) · inceleyen", role: "reviewer", model: "gpt-5.5-codex", state: "running_tool", worktree_id: null, created_at: iso(-9.4), last_usage: { input_tokens: 42_300, output_tokens: 3_980, context_used: 61_000, context_window: 192_000 } }),
      ],
      run_7: [
        session("ses_d7", { run_id: "run_7", task_id: "task_141" }),
        session("ses_r7", { run_id: "run_7", task_id: "task_141", provider: "codex", node_id: "review", label: "Çapraz inceleme (Codex) · inceleyen", role: "reviewer", model: "gpt-5.5-codex" }),
      ],
    },
    worktrees: {
      run_9: [{ id: "wt_1", repo_id: "repo_web", workspace_id: "ws_1", path: "/Users/demo/.aistudio/worktrees/odeme-web/limit-cubuklari-dev-1", branch: "aistudio/limit-cubuklari/dev-1", base_ref: "main", base_sha: "4f2a9c1e7b3d", run_id: "run_9", task_id: "task_142", label: "dev-1", status: "active", created_at: iso(-38) }],
      run_7: [],
    },
    timelines: { run_7: { run: run7, events: timelineEvents, session_ids: ["ses_d7", "ses_r7"], has_more: false } },
    posts: [],
    failTask: null,
  };
}

const diffResult = {
  base: "4f2a9c1e7b3d",
  head: "d4e5f6a7b8c9",
  additions: 25,
  deletions: 5,
  truncated: false,
  files: [
    { path: "apps/web/src/shell/LimitsWidget.tsx", old_path: null, status: "modified", additions: 8, deletions: 3, patch: patchWidget },
    { path: "apps/web/src/ui/LimitBar.tsx", old_path: null, status: "modified", additions: 3, deletions: 1, patch: patchBar },
    { path: "apps/web/src/ui/limits.test.ts", old_path: null, status: "added", additions: 8, deletions: 0, patch: patchTest },
    { path: "apps/web/src/assets/limit-ring.png", old_path: null, status: "binary", additions: 0, deletions: 0, patch: null },
  ],
};

const usage = {
  input_tokens: 182_500,
  output_tokens: 24_100,
  duration_ms: 31 * 60_000 + 12_000,
  turns: 14,
  five_hour_percent_spent: 8.5,
  weekly_percent_spent: 2.4,
  by_provider: {
    claude: { input_tokens: 140_200, output_tokens: 20_120, duration_ms: 23 * 60_000, turns: 9, five_hour: 6.4, weekly: 1.8 },
    codex: { input_tokens: 42_300, output_tokens: 3_980, duration_ms: 8 * 60_000, turns: 5, five_hour: 2.1, weekly: 0.6 },
  },
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installTaskApi(page: Page, mutate?: (s: Scenario) => void): Promise<{ api: MockApi; sc: Scenario }> {
  const api = await installMockApi(page, (st) => {
    st.approvals = [];
  });
  const sc = scenario();
  mutate?.(sc);
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();
    let m: RegExpExecArray | null;
    if (method === "POST") sc.posts.push({ path, body: req.postDataJSON() as unknown });

    if ((m = /^\/engine\/tasks\/([^/]+)$/.exec(path)) && method === "GET") {
      if (sc.failTask && sc.failTask.times > 0) {
        sc.failTask.times -= 1;
        return json(route, { error: { code: "internal", message: "Motor beklenmeyen bir hata verdi." } }, sc.failTask.status);
      }
      const d = sc.tasks[m[1]!];
      return d ? json(route, d) : json(route, { error: { code: "not_found", message: "Görev bulunamadı." } }, 404);
    }
    if ((m = /^\/engine\/tasks\/([^/]+)\/cancel$/.exec(path))) {
      const d = sc.tasks[m[1]!]!;
      (d.task as Json).status = "cancelled";
      return json(route, d.task);
    }
    if ((m = /^\/engine\/tasks\/([^/]+)\/start$/.exec(path))) {
      const d = sc.tasks[m[1]!]!;
      (d.task as Json).status = "queued";
      return json(route, d);
    }
    if ((m = /^\/engine\/tasks\/([^/]+)\/rating$/.exec(path))) {
      const body = req.postDataJSON() as { rating: number };
      sc.tasks[m[1]!]!.rating = body.rating;
      return json(route, sc.tasks[m[1]!]!.quality ?? { score: null, components: [], formula: "", run_id: null, computed_at: null });
    }
    if ((m = /^\/engine\/tasks\/([^/]+)\/quality$/.exec(path))) {
      // Provisional score of the running task: computed from the gates so far.
      if (m[1] !== "task_142") return json(route, { score: null, components: [], formula: "", run_id: null, computed_at: null });
      return json(route, {
        score: 74,
        components: [
          { key: "gates_first_pass", label: "Kapıların ilk denemede geçmesi", weight: 30, value: 0.5, detail: "1/2 kapı ilk denemede geçti.", raw: {} },
          { key: "review", label: "İnceleme bulgularının ağırlığı", weight: 25, value: null, detail: "Henüz inceleme yok.", raw: {} },
          { key: "tests", label: "Build/test komutları", weight: 25, value: 1, detail: "4/4 komut geçti (son kontrol).", raw: {} },
          { key: "rework", label: "Tekrar turları", weight: 10, value: 0.75, detail: "1 tekrar turu.", raw: {} },
          { key: "user_rating", label: "Kullanıcı puanı", weight: 10, value: null, detail: "Puan verilmedi.", raw: {} },
        ],
        formula: "Puan = 100 × Σ(ağırlık × değer) / Σ(ağırlık).",
        run_id: "run_9",
        computed_at: iso(-1),
      });
    }
    if (/^\/engine\/tasks\/[^/]+\/export$/.test(path)) {
      const fmt = url.searchParams.get("format") ?? "md";
      return route.fulfill({ status: 200, contentType: fmt === "json" ? "application/json" : "text/markdown", headers: { "content-disposition": `attachment; filename="limit-cubuklarini-ust-cubuga-ekle.${fmt}"` }, body: "# Limit çubuklarını üst çubuğa ekle\n" });
    }
    if ((m = /^\/engine\/runs\/([^/]+)$/.exec(path))) {
      const r = sc.runs[m[1]!];
      return r ? json(route, r) : json(route, { error: { code: "not_found", message: "Koşu bulunamadı." } }, 404);
    }
    if ((m = /^\/engine\/runs\/([^/]+)\/gates$/.exec(path))) return json(route, sc.gates[m[1]!] ?? []);
    if ((m = /^\/engine\/runs\/([^/]+)\/evidence$/.exec(path))) return json(route, sc.evidence[m[1]!] ?? []);
    if ((m = /^\/engine\/runs\/([^/]+)\/checkpoints$/.exec(path))) return json(route, sc.checkpoints[m[1]!] ?? []);
    if ((m = /^\/engine\/runs\/([^/]+)\/checkpoints\/([^/]+)\/restore$/.exec(path))) return json(route, sc.runs[m[1]!]);
    if ((m = /^\/engine\/runs\/([^/]+)\/nodes\/([^/]+)\/retry$/.exec(path))) return json(route, sc.runs[m[1]!]);
    if ((m = /^\/engine\/runs\/([^/]+)\/timeline$/.exec(path))) {
      const tl = sc.timelines[m[1]!];
      return tl ? json(route, tl) : json(route, { error: { code: "not_found", message: "Koşu bulunamadı." } }, 404);
    }
    if (/^\/engine\/modes\/[^/]+$/.test(path)) return json(route, duoGraph);
    if (path === "/agents/sessions" && url.searchParams.get("run_id")) return json(route, sc.sessions[url.searchParams.get("run_id")!] ?? []);
    if (path === "/gitops/worktrees") return json(route, sc.worktrees[url.searchParams.get("run_id") ?? ""] ?? []);
    if (/^\/gitops\/worktrees\/[^/]+\/diff$/.test(path)) return json(route, diffResult);
    if (/^\/gitops\/worktrees\/[^/]+\/merge-preview$/.test(path)) return json(route, { clean: true, conflicts: [], target_ref: "main", target_sha: "7c6b5a4f3e2d", diff: null });
    if (/^\/limits\/tasks\/[^/]+$/.test(path)) return json(route, usage);
    if (/^\/workspaces\/[^/]+\/repos$/.test(path)) return json(route, [{ id: "repo_web", workspace_id: "ws_1", name: "odeme-web", path: "/Users/demo/src/odeme-web", default_branch: "main" }]);
    return route.fallback();
  });
  return { api, sc };
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|Failed to load resource|ERR_CONNECTION_REFUSED|status of 404|status of 500/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function openTask(page: Page, id = "task_142") {
  await page.goto(`/#/tasks/${id}`);
  await expect(page.getByRole("group", { name: "Akış ilerlemesi" })).toBeVisible();
}

const node = (page: Page, label: RegExp | string) => page.locator(".react-flow__node").filter({ has: page.getByText(label, { exact: true }) });

// ----------------------------------------------------------------------------- tests

for (const scheme of ["light", "dark"] as const) {
  test(`task detail renders (${scheme})`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installTaskApi(page);
    await openTask(page);
    await expect(page.getByRole("heading", { level: 1, name: "Limit çubuklarını üst çubuğa ekle" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Çalışıyor" }).first()).toBeVisible();
    // The running review node is focused by default; its reviewer agent card is shown.
    await expect(page.getByRole("heading", { level: 2, name: "Çapraz inceleme (Codex)" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Çapraz inceleme \(Codex\) · inceleyen/ })).toBeVisible();
    await expect(page.getByText("geri döndü · tur 2")).toBeVisible();
    await settle(page, 1200);
    await page.screenshot({ path: shot(`task-detail-${scheme}`) });

    // Failed first build round: command evidence with exit codes, failing output expanded.
    await node(page, "Build/test kanıtı").click();
    await page.getByRole("radio", { name: "Tur 1" }).click();
    await expect(page.getByText("1/4 komut başarısız: odeme-web:test").first()).toBeVisible();
    await expect(page.getByText("çıkış 1")).toBeVisible();
    await expect(page.getByRole("log", { name: "test çıktısı" })).toBeVisible();
    await settle(page, 800);
    await page.screenshot({ path: shot(`task-detail-gate-${scheme}`) });

    // The writer: output markdown and agent-submitted evidence (never gate evidence).
    await node(page, "Yazar (Claude)").click();
    await expect(page.getByRole("heading", { name: "Değişiklikler" })).toBeVisible();
    await expect(page.getByText("Ajan tarafından eklendi — kapı kanıtı değildir")).toBeVisible();

    // Changes: worktree, merge preview, file tree and diff.
    await page.getByRole("tab", { name: "Değişiklikler" }).click();
    await expect(page.getByText("aistudio/limit-cubuklari/dev-1").first()).toBeVisible();
    await expect(page.getByText("Çakışma yok")).toBeVisible();
    await expect(page.getByRole("tree", { name: "Değişen dosyalar" })).toBeVisible();
    await page.getByRole("treeitem", { name: /LimitBar\.tsx/ }).click();
    await expect(page.locator(".cm-editor").first()).toBeVisible();
    await settle(page, 900);
    await page.locator("section").filter({ has: page.getByRole("tab", { name: "Değişiklikler" }) }).screenshot({ path: shot(`task-detail-changes-${scheme}`) });

    await page.getByRole("tab", { name: /Checkpoint'ler/ }).click();
    await expect(page.getByText("Build/test kanıtı sonrası")).toBeVisible();
    await settle(page, 600);
    await page.locator("section").filter({ has: page.getByRole("tab", { name: "Değişiklikler" }) }).screenshot({ path: shot(`task-detail-checkpoints-${scheme}`) });
    await page.getByRole("tab", { name: /Kapılar/ }).click();
    await expect(page.getByRole("button", { name: /Build\/test kanıtı.*1\/4 komut başarısız/ })).toBeVisible();
    await settle(page, 600);
    await page.locator("section").filter({ has: page.getByRole("tab", { name: "Değişiklikler" }) }).screenshot({ path: shot(`task-detail-gates-${scheme}`) });

    expect(errors).toEqual([]);
  });

  test(`completed task: quality breakdown and review findings (${scheme})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installTaskApi(page);
    await openTask(page, "task_141");
    await expect(page.getByRole("status", { name: "Tamamlandı" }).first()).toBeVisible();
    await expect(page.getByRole("radio", { name: "4 yıldız" })).toHaveAttribute("aria-checked", "true");
    await node(page, "Çapraz inceleme (Codex)").click();
    await expect(page.getByRole("table")).toContainText("LimitsWidget.tsx:48");
    await settle(page, 900);
    await page.screenshot({ path: shot(`task-detail-completed-${scheme}`) });
    await page.getByRole("button", { name: /Kalite puanı: 86/ }).click();
    await expect(page.getByRole("dialog", { name: "Kalite puanı" })).toContainText("Kapıların ilk denemede geçmesi");
    await settle(page, 700);
    await page.screenshot({ path: shot(`task-detail-quality-${scheme}`) });
    expect(errors).toEqual([]);
  });
}

test("live events morph the flow: gate passes, baton hands off, approval appears", async ({ page }) => {
  const { api, sc } = await installTaskApi(page);
  await openTask(page);
  const review = node(page, "Çapraz inceleme (Codex)");
  await expect(review).toHaveAttribute("aria-label", "Çapraz inceleme (Codex): Çalışıyor");
  const env = { task_id: "task_142", run_id: "run_9" };
  // studiod persists before it emits: refetches see the same state as the events.
  const nodes = (sc.runs.run_9 as { nodes: Json[] }).nodes;
  Object.assign(nodes[nodes.length - 1]!, { status: "passed", finished_at: iso(0), output: "2 bulgu, engelleyici yok." });
  nodes.push(nodeRun("run_9", "final", 1, "running", 0, null));
  api.push("gate.passed", { node_id: "review", gate: "cross_review", summary: "2 bulgu, engelleyici yok.", attempt: 1 }, env);
  api.push("node.completed", { node_id: "review", node_run_id: "nr_run_9_review_1", status: "passed", output_preview: "2 bulgu, engelleyici yok." }, env);
  api.push("run.edge", { edge_id: "e_review_final", source: "review", target: "final" }, env);
  api.push("node.started", { node_id: "final", node_run_id: "nr_run_9_final_1", attempt: 1, label: "Son onay" }, env);
  await expect(review).toHaveAttribute("aria-label", "Çapraz inceleme (Codex): Tamamlandı");
  await expect(node(page, "Son onay")).toHaveAttribute("aria-label", "Son onay: Çalışıyor");
  // The baton travels along the review → final edge (dashed trail while handing off).
  await expect(page.locator('.react-flow__edge[data-id="e_review_final"] path[stroke-dasharray="3 9"]')).toHaveCount(1);
  await expect(page.getByText("4/5 adım")).toBeVisible();

  api.state.approvals.push(approval("apr_final", { kind: "final", title: "Son onay: Limit çubuklarını üst çubuğa ekle", task_id: "task_142", run_id: "run_9", severity: "normal", payload: { engine_ref: "nr_run_9_final_1:final" } }));
  api.push("approval.requested", { approval_id: "apr_final", kind: "final", title: "Son onay" }, env);
  nodes[nodes.length - 1]!.status = "waiting";
  api.push("node.waiting", { node_id: "final", node_run_id: "nr_run_9_final_1", reason: "Son onay bekleniyor", wait_kind: "approval" }, env);
  await expect(page.getByRole("heading", { name: "Onayın bekleniyor" })).toBeVisible();
  await expect(node(page, "Son onay")).toHaveAttribute("aria-label", "Son onay: Onay bekliyor");
  await settle(page, 900);
  await page.screenshot({ path: shot("task-detail-live-approval") });
});

test("agent card opens the live session in the drawer", async ({ page }) => {
  await installTaskApi(page);
  await openTask(page);
  await page.getByRole("button", { name: /Çapraz inceleme \(Codex\) · inceleyen/ }).click();
  const drawer = page.getByRole("complementary", { name: "Çapraz inceleme (Codex) · inceleyen" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("ses_rev");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("keyboard: arrows move the node selection on the canvas", async ({ page }) => {
  await installTaskApi(page);
  await openTask(page);
  await node(page, "Build/test kanıtı").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: "Build/test kanıtı" })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("heading", { level: 2, name: "Sınır denetimi" })).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("heading", { level: 2, name: "Son onay" })).toBeVisible();
});

test("cancel asks for confirmation, export downloads, rating posts", async ({ page }) => {
  const { sc } = await installTaskApi(page);
  await openTask(page);
  await page.getByRole("button", { name: "İptal et" }).click();
  const dialog = page.getByRole("dialog", { name: "Görev iptal edilsin mi?" });
  await expect(dialog).toBeVisible();
  await settle(page, 400);
  await page.screenshot({ path: shot("task-detail-cancel-confirm") });
  await dialog.getByRole("button", { name: "Görevi iptal et" }).click();
  await expect(page.getByText("Görev iptal edildi").first()).toBeVisible();
  expect(sc.posts.map((p) => p.path)).toContain("/engine/tasks/task_142/cancel");

  await page.getByRole("button", { name: "Dışa aktar" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Markdown (.md)" }).click();
  expect((await download).suggestedFilename()).toBe("limit-cubuklarini-ust-cubuga-ekle.md");

  await page.goto("/#/tasks/task_141");
  // The previous task's page animates out; act on the one that is arriving.
  const header = page.locator("header").filter({ hasText: "task_141" });
  await header.getByRole("radio", { name: "5 yıldız" }).click();
  await expect(page.getByText("Görev 5 yıldızla puanlandı")).toBeVisible();
  expect(sc.posts.find((p) => p.path === "/engine/tasks/task_141/rating")?.body).toEqual({ rating: 5 });
});

test("retry a failed node and restore a checkpoint", async ({ page }) => {
  const { sc } = await installTaskApi(page, (s) => {
    const run = s.runs.run_9 as { nodes: Json[] };
    run.nodes = run.nodes.filter((n) => n.node_id !== "review");
    run.nodes[run.nodes.length - 1] = { ...run.nodes[run.nodes.length - 1]!, status: "failed", error: "1/4 komut başarısız: odeme-web:test" };
    (s.tasks.task_142!.current_run as Json).nodes = run.nodes;
  });
  await openTask(page);
  await expect(page.getByRole("heading", { level: 2, name: "Build/test kanıtı" })).toBeVisible();
  await page.getByRole("button", { name: "Yeniden dene" }).click();
  await expect(page.getByText("Build/test kanıtı yeniden deneniyor")).toBeVisible();
  expect(sc.posts.map((p) => p.path)).toContain("/engine/runs/run_9/nodes/build/retry");

  await page.getByRole("tab", { name: /Checkpoint'ler/ }).click();
  await page.getByRole("button", { name: "Geri dön: Build/test kanıtı sonrası" }).click();
  const dialog = page.getByRole("dialog", { name: "Bu checkpoint'e geri dönülsün mü?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Geri dön" }).click();
  await expect(page.getByText("\"Build/test kanıtı sonrası\" anına geri dönüldü")).toBeVisible();
  expect(sc.posts.map((p) => p.path)).toContain("/engine/runs/run_9/checkpoints/ck_3/restore");
});

test("palette lists the task's commands and opens the replay", async ({ page }) => {
  await installTaskApi(page);
  await openTask(page, "task_141");
  await page.keyboard.press(`${mod}+k`);
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await page.keyboard.type("dışa aktar");
  await expect(palette.getByRole("option", { name: /Görevi Markdown olarak dışa aktar/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /Görevi JSON olarak dışa aktar/ })).toBeVisible();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type("tekrar oynat");
  await palette.getByRole("option", { name: /Görevin tekrar oynatmasını aç/ }).click();
  await expect(page).toHaveURL(/#\/tasks\/runs\/run_7$/);
  await expect(page.getByRole("slider", { name: "Zaman çizelgesi" })).toBeVisible();
});

test("a task that has not started previews its mode's flow", async ({ page }) => {
  const { sc } = await installTaskApi(page);
  await openTask(page, "task_150");
  await expect(page.getByText("Önizleme: görev başlayınca bu akış çalışacak.")).toBeVisible();
  await expect(node(page, "Son onay")).toHaveAttribute("aria-label", "Son onay: Bekliyor");
  await settle(page, 800);
  await page.screenshot({ path: shot("task-detail-draft") });
  await page.getByRole("button", { name: "Başlat" }).click();
  await expect(page.getByText("Görev kuyruğa alındı")).toBeVisible();
  expect(sc.posts.find((p) => p.path === "/engine/tasks/task_150/start")?.body).toEqual({});
});

test("error states: not found, then a failing load with a working retry", async ({ page }) => {
  await installTaskApi(page, (s) => {
    s.failTask = { status: 500, times: 3 }; // the first load and its two automatic retries
  });
  await page.goto("/#/tasks/task_142");
  await expect(page.getByText("Görev yüklenemedi")).toBeVisible();
  await expect(page.getByText("Motor beklenmeyen bir hata verdi.")).toBeVisible();
  await settle(page, 500);
  await page.screenshot({ path: shot("task-detail-error") });
  await page.getByRole("button", { name: "Tekrar dene" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Limit çubuklarını üst çubuğa ekle" })).toBeVisible();

  await page.goto("/#/tasks/task_404");
  await expect(page.getByText("Görev bulunamadı")).toBeVisible();
  await page.getByRole("button", { name: "Görevlere dön" }).click();
  await expect(page).toHaveURL(/#\/tasks$/);
});

for (const scheme of ["light", "dark"] as const) {
  test(`run replay: scrub, play and follow the event list (${scheme})`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await installTaskApi(page);
    await page.goto("/#/tasks/runs/run_7");
    const slider = page.getByRole("slider", { name: "Zaman çizelgesi" });
    await expect(slider).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Tekrar oynatma" })).toBeVisible();
    // Autoplay starts; pause it and drive the playhead by keyboard.
    const playPause = page.getByRole("button", { name: /^(Oynat|Duraklat|Baştan oynat)$/ });
    await expect(page.getByRole("button", { name: "Duraklat" })).toBeVisible();
    await playPause.click();
    await slider.focus();
    await page.keyboard.press("Home");
    await expect(node(page, "Yazar (Claude)")).toHaveAttribute("aria-label", "Yazar (Claude): Bekliyor");

    // Jump to the first build/test moment: the writer is done, the gate is running.
    await page.getByRole("option", { name: /Build\/test kanıtı başladı/ }).click();
    await expect(node(page, "Yazar (Claude)")).toHaveAttribute("aria-label", "Yazar (Claude): Tamamlandı");
    await expect(node(page, "Build/test kanıtı")).toHaveAttribute("aria-label", "Build/test kanıtı: Çalışıyor");
    await settle(page, 900);
    await page.screenshot({ path: shot(`task-replay-${scheme}`) });

    // Key moment navigation, then the end state.
    await page.keyboard.press("Shift+ArrowRight");
    await expect(node(page, "Build/test kanıtı")).toHaveAttribute("aria-label", "Build/test kanıtı: Tamamlandı");
    await slider.focus();
    await page.keyboard.press("End");
    await expect(node(page, "Son onay")).toHaveAttribute("aria-label", "Son onay: Tamamlandı");
    await expect(page.getByRole("option", { name: /Koşu tamamlandı/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("radio", { name: "Tümü" }).click();
    await expect(page.getByRole("option", { name: /git diff --stat/ })).toBeVisible();
    await settle(page, 700);
    await page.screenshot({ path: shot(`task-replay-end-${scheme}`) });
    expect(errors).toEqual([]);
  });
}

test("reduced motion: the replay does not autoplay and the canvas still renders", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installTaskApi(page);
  await page.goto("/#/tasks/runs/run_7");
  await expect(page.getByRole("slider", { name: "Zaman çizelgesi" })).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.getByRole("button", { name: "Oynat" })).toBeVisible();
  await expect(node(page, "Yazar (Claude)")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Duraklat" })).toBeVisible();
});

test("replay plays through to the end at 8×", async ({ page }) => {
  await installTaskApi(page);
  await page.goto("/#/tasks/runs/run_7");
  await expect(page.getByRole("button", { name: "Duraklat" })).toBeVisible();
  await page.getByRole("radio", { name: "8×" }).click();
  await expect(node(page, "Son onay")).toHaveAttribute("aria-label", "Son onay: Tamamlandı", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Baştan oynat" })).toBeVisible();
});
