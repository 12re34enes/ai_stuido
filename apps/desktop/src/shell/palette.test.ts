import { commandGroups, type StudioCommand } from "@/lib/commands";

import { paletteSections } from "./palette";
import { featureForPath, featurePath, sectionKey } from "./route";

const cmd = (id: string, group?: string, extra: Partial<StudioCommand> = {}): StudioCommand => ({ id, title: id, group, run: () => {}, ...extra });

describe("paletteSections", () => {
  const commands = [
    cmd("theme", commandGroups.view),
    cmd("nav.tasks", commandGroups.navigation, { order: 1 }),
    cmd("nav.home", commandGroups.navigation, { order: 0 }),
    cmd("custom", "Özel"),
    cmd("hidden", commandGroups.actions, { visible: false }),
    cmd("act", undefined),
  ];

  it("orders groups and commands, hides invisible ones", () => {
    const sections = paletteSections(commands, [], "");
    expect(sections.map((s) => s.group)).toEqual([commandGroups.navigation, commandGroups.actions, commandGroups.view, "Özel"]);
    expect(sections[0]!.entries.map((e) => e.cmd.id)).toEqual(["nav.home", "nav.tasks"]);
    expect(sections.flatMap((s) => s.entries).some((e) => e.cmd.id === "hidden")).toBe(false);
  });

  it("puts recent commands first with unique values, only without a query", () => {
    const withRecent = paletteSections(commands, ["theme", "gone"], "");
    expect(withRecent[0]).toMatchObject({ group: commandGroups.recent });
    expect(withRecent[0]!.entries.map((e) => e.value)).toEqual(["recent:theme"]);
    expect(paletteSections(commands, ["theme"], "tem")[0]!.group).not.toBe(commandGroups.recent);
  });
});

describe("route helpers", () => {
  it("derives section keys and feature paths", () => {
    expect(sectionKey("/")).toBe("home");
    expect(sectionKey("/tasks/42/run")).toBe("tasks");
    expect(featureForPath("/tasks/42")?.id).toBe("tasks");
    expect(featureForPath("/")?.id).toBe("home");
    expect(featurePath({ path: "/flows/*" } as Parameters<typeof featurePath>[0])).toBe("/flows");
  });
});
