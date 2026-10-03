import { Database, FileInput, FolderGit2, Plus, Rocket, ScrollText, Server } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "react-router";

import { variants } from "@/motion/tokens";
import { Button, CountBadge, Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui";

import { useDbProfiles, useDeployProfiles, useGitAccounts, useHosts } from "./api";
import { AuditTab } from "./audit/AuditTab";
import { DatabasesTab } from "./databases/DatabasesTab";
import { DeployTab } from "./deploy/DeployTab";
import { GitTab } from "./git/GitTab";
import { HostsTab } from "./hosts/HostsTab";
import { PageBody, PageHeader } from "./kit";
import { isTab, type ConnectionsTab } from "./logic";
import { useConnectionsUi } from "./store";
import { connStrings as s } from "./strings";

function Count({ n }: { n: number | undefined }) {
  return <CountBadge count={n ?? 0} tone="neutral" className="ml-0.5" />;
}

/** Bağlantılar: header, URL-synced tabs and the active tab's primary actions. */
export function ConnectionsHome() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const open = useConnectionsUi((st) => st.open);
  const hosts = useHosts();
  const dbs = useDbProfiles();
  const deploys = useDeployProfiles();
  const git = useGitAccounts();
  if (tab !== undefined && !isTab(tab)) return <Navigate to="/connections/hosts" replace />;
  const current: ConnectionsTab = tab ?? "hosts";

  const actions: Record<ConnectionsTab, ReactNode> = {
    hosts: (
      <>
        <Button icon={<FileInput />} onClick={() => open("host.import")}>
          {s.hosts.import}
        </Button>
        <Button variant="primary" icon={<Plus />} onClick={() => open("host.new")}>
          {s.hosts.add}
        </Button>
      </>
    ),
    databases: (
      <Button variant="primary" icon={<Plus />} onClick={() => open("db.new")}>
        {s.databases.add}
      </Button>
    ),
    deploy: (
      <Button variant="primary" icon={<Plus />} onClick={() => open("deploy.new")}>
        {s.deploy.add}
      </Button>
    ),
    git: (
      <Button variant="primary" icon={<Plus />} onClick={() => open("git.new")}>
        {s.git.add}
      </Button>
    ),
    audit: null,
  };

  return (
    <PageBody>
      <PageHeader title={s.title} description={current === "audit" ? s.audit.description : s.description} />
      <Tabs value={current} onValueChange={(v) => void navigate(`/connections/${v}`)} className="gap-6">
        <div className="relative">
          <TabsList aria-label={s.title}>
            <TabsTrigger value="hosts" icon={<Server />} trailing={<Count n={hosts.data?.length} />}>
              {s.tabs.hosts}
            </TabsTrigger>
            <TabsTrigger value="databases" icon={<Database />} trailing={<Count n={dbs.data?.length} />}>
              {s.tabs.databases}
            </TabsTrigger>
            <TabsTrigger value="deploy" icon={<Rocket />} trailing={<Count n={deploys.data?.length} />}>
              {s.tabs.deploy}
            </TabsTrigger>
            <TabsTrigger value="git" icon={<FolderGit2 />} trailing={<Count n={git.data?.length} />}>
              {s.tabs.git}
            </TabsTrigger>
            <TabsTrigger value="audit" icon={<ScrollText />}>
              {s.tabs.audit}
            </TabsTrigger>
          </TabsList>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div key={current} {...variants.fade} className="absolute right-0 bottom-1 flex items-center gap-2">
              {actions[current]}
            </motion.div>
          </AnimatePresence>
        </div>
        <TabsContent value="hosts">
          <HostsTab />
        </TabsContent>
        <TabsContent value="databases">
          <DatabasesTab />
        </TabsContent>
        <TabsContent value="deploy">
          <DeployTab />
        </TabsContent>
        <TabsContent value="git">
          <GitTab />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </PageBody>
  );
}
