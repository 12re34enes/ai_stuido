/**
 * Global palette commands of the teams feature, registered when the chunk loads (the shell
 * prefetches every feature chunk at startup): "Yeni ekip". "Ekipler" comes from the shell's
 * navigation registry, "Yeni görev: Ekip" from the task commands; "Bu ekiple görev başlat" is
 * registered by the list (one per team) and the builder (current team).
 */
import { UserPlus } from "lucide-react";

import { commandGroups, registerCommands } from "@/lib/commands";

import { s } from "./strings";

let installed = false;

export function installTeamCommands(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  registerCommands([
    {
      id: "teams.new",
      title: s.commands.newTeam,
      group: commandGroups.actions,
      icon: UserPlus,
      order: 3,
      keywords: ["team", "ekip", "yeni", "org", "danışman", "lider"],
      run: () => {
        window.location.hash = "#/teams/new";
      },
    },
  ]);
}
