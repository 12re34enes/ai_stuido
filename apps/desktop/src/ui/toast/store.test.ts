import { MAX_TOASTS, toast, useToasts } from "./store";

describe("toast store", () => {
  beforeEach(() => useToasts.setState({ toasts: [] }));

  it("adds toasts with tone defaults", () => {
    toast.success("Tamam");
    const err = toast.error("Olmadı");
    const [a, b] = useToasts.getState().toasts;
    expect(a).toMatchObject({ title: "Tamam", tone: "success", duration: 5000 });
    expect(b).toMatchObject({ id: err, tone: "danger", duration: 8000 });
  });

  it("updates in place when the id is reused", () => {
    toast({ id: "conn", title: "Bağlanıyor" });
    toast({ id: "conn", title: "Bağlandı", tone: "success" });
    expect(useToasts.getState().toasts).toHaveLength(1);
    expect(useToasts.getState().toasts[0]).toMatchObject({ title: "Bağlandı", tone: "success" });
  });

  it("keeps at most MAX_TOASTS and dismisses", () => {
    for (let i = 0; i < MAX_TOASTS + 3; i++) toast({ title: `t${i}` });
    const list = useToasts.getState().toasts;
    expect(list).toHaveLength(MAX_TOASTS);
    expect(list[0]!.title).toBe("t3");
    toast.dismiss(list[0]!.id);
    expect(useToasts.getState().toasts).toHaveLength(MAX_TOASTS - 1);
    toast.dismiss();
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
