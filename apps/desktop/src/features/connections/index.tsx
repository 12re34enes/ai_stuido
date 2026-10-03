/**
 * Bağlantılar (spec §12–14, §19): SSH hosts, databases + query console, deploy profiles and
 * runs, git hosting accounts, the remote audit log and the remote terminal.
 *
 *   /connections/:tab                 hosts | databases | deploy | git | audit
 *   /connections/hosts/:id            host detail          /connections/hosts/:id/terminal
 *   /connections/databases/:id        database + console   /connections/deploy/:id  profile + runs
 */
import { Database, FileInput, FolderGit2, Rocket, ScrollText, Server } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useMemo } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router";

import { commandGroups, useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { RouteFallback } from "@/shell/RouteFallback";
import { variants } from "@/motion/tokens";

import { useConnectionsLive } from "./api";
import { ConnectionsHome } from "./ConnectionsHome";
import { DbDetailPage } from "./databases/DbDetail";
import { DeployDetailPage } from "./deploy/DeployDetail";
import { HostDetailPage } from "./hosts/HostDetail";
import { connectionsRouteKey } from "./logic";
import { useConnectionsUi, type ConnectionsDialog } from "./store";
import { connStrings as s } from "./strings";

// xterm.js only loads when a terminal opens.
const TerminalPage = lazy(() => import("./terminal/TerminalPage").then((m) => ({ default: m.TerminalPage })));

function useConnectionsCommands() {
  const navigate = useNavigate();
  const open = useConnectionsUi((st) => st.open);
  const commands = useMemo<StudioCommand[]>(() => {
    const create = (id: string, title: string, tab: string, dialog: ConnectionsDialog, icon: StudioCommand["icon"], keywords: string[]): StudioCommand => ({
      id,
      title,
      group: commandGroups.actions,
      icon,
      keywords,
      run: () => {
        void navigate(`/connections/${tab}`);
        open(dialog);
      },
    });
    return [
      create("connections.host.new", s.hosts.add, "hosts", "host.new", Server, ["ssh", "host", "sunucu", "yeni"]),
      create("connections.host.import", s.hosts.import, "hosts", "host.import", FileInput, ["ssh config", "içe aktar", "import"]),
      create("connections.db.new", s.databases.add, "databases", "db.new", Database, ["database", "veritabanı", "postgres", "mysql"]),
      create("connections.deploy.new", s.deploy.add, "deploy", "deploy.new", Rocket, ["deploy", "dağıtım", "profil"]),
      create("connections.git.new", `Git ${s.git.add.toLocaleLowerCase("tr-TR")}`, "git", "git.new", FolderGit2, ["github", "gitlab", "token", "hesap"]),
      {
        id: "connections.audit",
        title: s.audit.title,
        subtitle: s.title,
        group: commandGroups.navigation,
        icon: ScrollText,
        keywords: ["audit", "kayıt", "denetim", "log"],
        order: 50,
        run: () => void navigate("/connections/audit"),
      },
    ];
  }, [navigate, open]);
  useRegisterCommands(commands);
}

export default function ConnectionsPage() {
  useConnectionsLive();
  useConnectionsCommands();
  const location = useLocation();
  const key = connectionsRouteKey(location.pathname);
  const terminal = key.endsWith("/terminal");
  return (
    <div className={terminal ? "relative h-full" : "relative min-h-full"} data-feature="connections">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div key={key} variants={variants.fadeUp} initial="initial" animate="animate" exit="exit" className={terminal ? "h-full" : undefined}>
          <Routes location={location}>
            <Route
              path="hosts/:id/terminal"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <TerminalPage />
                </Suspense>
              }
            />
            <Route path="hosts/:id" element={<HostDetailPage />} />
            <Route path="databases/:id" element={<DbDetailPage />} />
            <Route path="deploy/:id" element={<DeployDetailPage />} />
            <Route path=":tab?" element={<ConnectionsHome />} />
          </Routes>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
