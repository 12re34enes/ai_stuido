import { ApiError } from "@/lib/api";
import type { EventFilter, StudioEvent } from "@/lib/events";

import { ALERT_EVENT_TYPE, alertToNotification, startAlertsBridge } from "./alerts";
import { enterTauri, flush, leaveTauri } from "./testing";
import type { NotificationActionEvent, NotifyInput } from "./types";

class FakeStream {
  static last: FakeStream | null = null;
  listeners = new Set<(batch: StudioEvent[]) => void>();
  closed = false;

  constructor(readonly filter: EventFilter) {
    FakeStream.last = this;
  }

  subscribe(fn: (batch: StudioEvent[]) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    this.closed = true;
  }

  push(type: string, payload: Record<string, unknown>) {
    const ev: StudioEvent = {
      id: 1,
      ts: "2026-10-03T08:00:00Z",
      type,
      severity: "high",
      actor: "system",
      workspace_id: null,
      task_id: null,
      run_id: null,
      session_id: null,
      payload,
      ephemeral: false,
    };
    for (const fn of this.listeners) fn([ev]);
  }
}

function setup(decide?: (id: string, approve: boolean) => Promise<unknown>) {
  const shown: NotifyInput[] = [];
  let actionHandler: ((e: NotificationActionEvent) => void) | null = null;
  const decisions: Array<[string, boolean]> = [];
  const stop = startAlertsBridge({
    force: true,
    createStream: (filter) => new FakeStream(filter),
    notify: async (input) => {
      shown.push(input);
      return { delivered: true };
    },
    onAction: (h) => {
      actionHandler = h;
      return () => {
        actionHandler = null;
      };
    },
    decide:
      decide ??
      (async (id, approve) => {
        decisions.push([id, approve]);
      }),
  });
  const stream = FakeStream.last!;
  const click = (e: NotificationActionEvent) => actionHandler?.(e);
  return { shown, decisions, stream, click, stop, hasActionHandler: () => actionHandler !== null };
}

const approvalAlert = {
  alert_id: "alr_1",
  title: "Production deploy onayı bekliyor",
  body: "api-prod · v1.4.2",
  severity: "critical",
  approval_id: "apr_1",
  sound: true,
};

afterEach(() => {
  leaveTauri();
  vi.restoreAllMocks();
});

describe("alertToNotification", () => {
  it("adds Onayla/Reddet/Aç for approvals with a default deep link", () => {
    expect(alertToNotification(approvalAlert as never)).toEqual({
      id: "alr_1",
      title: "Production deploy onayı bekliyor",
      body: "api-prod · v1.4.2",
      severity: "critical",
      actions: ["approve", "reject", "open"],
      deepLink: "aistudio://approval/apr_1",
      sound: true,
      approvalId: "apr_1",
    });
  });

  it("uses only Aç for plain alerts with a link and nothing without one", () => {
    expect(
      alertToNotification({ alert_id: "a", title: "Görev tamamlandı", body: "", severity: "normal", deep_link: "aistudio://task/tsk_1" }),
    ).toMatchObject({ actions: ["open"], deepLink: "aistudio://task/tsk_1" });
    expect(alertToNotification({ alert_id: "b", title: "Limit %80", body: "", severity: "normal" })).toMatchObject({
      actions: undefined,
      deepLink: undefined,
    });
  });

  it("drops foreign links and malformed payloads", () => {
    expect(
      alertToNotification({ alert_id: "a", title: "t", body: "", severity: "normal", deep_link: "https://evil.example" }),
    ).toMatchObject({ deepLink: undefined, actions: undefined });
    expect(alertToNotification(null)).toBeNull();
    expect(alertToNotification({ title: "no id" })).toBeNull();
    expect(alertToNotification({ alert_id: "x" })).toBeNull();
  });
});

describe("startAlertsBridge", () => {
  it("is a no-op outside the desktop app", () => {
    const createStream = vi.fn();
    const stop = startAlertsBridge({ createStream });
    expect(createStream).not.toHaveBeenCalled();
    stop();
  });

  it("subscribes to alert.notify and shows each alert once", async () => {
    const { shown, stream } = setup();
    expect(stream.filter).toEqual({ types: [ALERT_EVENT_TYPE] });
    stream.push(ALERT_EVENT_TYPE, approvalAlert);
    stream.push(ALERT_EVENT_TYPE, approvalAlert);
    stream.push("task.completed", { alert_id: "zzz", title: "ignored" });
    await flush();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ id: "alr_1", approvalId: "apr_1", actions: ["approve", "reject", "open"] });
  });

  it("posts approve / reject decisions from notification buttons", async () => {
    const { decisions, click } = setup();
    click({ id: "alr_1", action: "approve", approvalId: "apr_1", deepLink: null });
    click({ id: "alr_2", action: "reject", approvalId: "apr_2", deepLink: null });
    click({ id: "alr_3", action: "open", approvalId: "apr_3", deepLink: "aistudio://approval/apr_3" });
    click({ id: "alr_4", action: "click", approvalId: null, deepLink: null });
    await flush();
    expect(decisions).toEqual([
      ["apr_1", true],
      ["apr_2", false],
    ]);
  });

  it("falls back to the approval remembered for the notification id", async () => {
    const { decisions, click, stream } = setup();
    stream.push(ALERT_EVENT_TYPE, approvalAlert);
    await flush();
    click({ id: "alr_1", action: "approve", approvalId: null, deepLink: null });
    await flush();
    expect(decisions).toEqual([["apr_1", true]]);
  });

  it("sends the user to the app when the backend refuses the channel", async () => {
    const { shown, click } = setup(async () => {
      throw new ApiError(403, "permission_denied", "Production onayları yalnız uygulamadan verilebilir.");
    });
    click({ id: "alr_1", action: "approve", approvalId: "apr_1", deepLink: null });
    await flush();
    expect(shown).toEqual([
      {
        id: "alr_1:decision-error",
        title: "Bu onay yalnız uygulamadan verilebilir",
        body: "Production onayları yalnız uygulamadan verilebilir.",
        severity: "high",
        actions: ["open"],
        deepLink: "aistudio://approval/apr_1",
      },
    ]);
  });

  it("stops cleanly", () => {
    const { stream, stop, hasActionHandler } = setup();
    stop();
    expect(stream.closed).toBe(true);
    expect(stream.listeners.size).toBe(0);
    expect(hasActionHandler()).toBe(false);
  });

  it("posts the decision to studiod with channel=notification by default", async () => {
    const port = 40000 + Math.floor(Math.random() * 1000);
    enterTauri("main", (cmd) => {
      if (cmd === "backend_info") return { url: `http://127.0.0.1:${port}`, token: "test-token" };
      if (cmd === "native_ready") return [];
      return null;
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "apr_9", status: "approved" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let handler: ((e: NotificationActionEvent) => void) | null = null;
    const stop = startAlertsBridge({
      createStream: (filter) => new FakeStream(filter),
      notify: async () => ({}),
      onAction: (h) => {
        handler = h;
        return () => {};
      },
    });
    handler!({ id: "alr_9", action: "approve", approvalId: "apr_9", deepLink: null });
    await flush(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:${port}/api/approvals/apr_9/decision`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ approve: true, channel: "notification" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    stop();
    vi.unstubAllGlobals();
  });
});
