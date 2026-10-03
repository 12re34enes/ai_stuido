/**
 * Approvals feature (`/approvals/*`): inbox (pending / decided) and the detail page with the
 * full ApprovalCard. The detail page pushes its environment (production → red frame).
 */
import { ArrowRight, ChevronLeft, Inbox } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { Route, Routes, useLocation, useNavigate, useParams } from "react-router";

import { ApiError } from "@/lib/api";
import { commandGroups, useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { useEnvironmentScope } from "@/lib/environment";
import { variants } from "@/motion/tokens";
import { Button, Skeleton } from "@/ui";

import { backdrop, drill } from "../sessions/kit/motion";
import { ErrorState, PageColumn } from "../sessions/kit/Page";
import { useApproval, useApprovalsLive, usePendingApprovalList } from "./api";
import { ApprovalCard } from "./ApprovalCard";
import { ApprovalsInbox } from "./ApprovalsInbox";
import { sortPending } from "./filters";
import { approvalEnvironment, approvalTarget } from "./payload";
import { approvalStrings as s } from "./strings";

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <div className="flex gap-4">
        <Skeleton width={40} height={40} className="rounded-lg" />
        <div className="flex flex-1 flex-col gap-2.5">
          <Skeleton height={10} width={140} />
          <Skeleton height={20} width="70%" />
          <Skeleton height={9} width={260} />
        </div>
      </div>
      <Skeleton height={120} className="rounded-xl" />
      <Skeleton height={56} className="rounded-xl" />
    </div>
  );
}

function ApprovalDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const q = useApproval(id);
  const pending = usePendingApprovalList();
  const [decided, setDecided] = useState(false);
  const approval = q.data;
  useEnvironmentScope(approval ? approvalEnvironment(approval) : null, approval ? approvalTarget(approval) : undefined);
  const next = useMemo(() => sortPending(pending.data ?? []).find((a) => a.id !== id) ?? null, [id, pending.data]);
  const notFound = q.error instanceof ApiError && q.error.status === 404;

  return (
    <PageColumn size="narrow" className="pb-12">
      <div className="flex h-12 items-center">
        <Button size="sm" variant="ghost" icon={<ChevronLeft />} className="-ml-2.5" onClick={() => void navigate("/approvals")}>
          {s.back}
        </Button>
      </div>
      {q.isLoading && !approval ? (
        <DetailSkeleton />
      ) : !approval ? (
        <ErrorState
          title={notFound ? s.notFound : s.loadError}
          error={notFound ? undefined : q.error}
          onRetry={notFound ? undefined : () => void q.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <ApprovalCard approval={approval} variant="full" onDecided={() => setDecided(true)} />
          <AnimatePresence>
            {(decided || approval.status !== "pending") && (
              <motion.div key="next" {...variants.fadeUp} className="flex items-center justify-end gap-2">
                <Button variant="ghost" icon={<Inbox />} onClick={() => void navigate("/approvals")}>
                  {s.actions.backToInbox}
                </Button>
                {next && (
                  <Button variant="primary" iconRight={<ArrowRight className="size-4" />} onClick={() => void navigate(`/approvals/${next.id}`)}>
                    {s.actions.next}
                  </Button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </PageColumn>
  );
}

export default function ApprovalsFeature() {
  useApprovalsLive();
  const location = useLocation();
  const navigate = useNavigate();
  const rest = location.pathname.replace(/^\/approvals\/?/, "");
  const detail = rest !== "" && rest !== "decided";
  const commands = useMemo<StudioCommand[]>(
    () => [
      {
        id: "approvals.pending",
        title: "Bekleyen onaylar",
        group: commandGroups.navigation,
        icon: Inbox,
        keywords: ["approvals", "onay", "inbox"],
        run: () => void navigate("/approvals"),
      },
      {
        id: "approvals.decided",
        title: "Sonuçlanan onaylar",
        group: commandGroups.navigation,
        icon: Inbox,
        keywords: ["approvals", "geçmiş", "history"],
        run: () => void navigate("/approvals/decided"),
      },
    ],
    [navigate],
  );
  useRegisterCommands(commands);
  return (
    <div className="relative h-full">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={detail ? `detail:${rest}` : "inbox"}
          variants={detail ? drill : backdrop}
          initial="initial"
          animate="animate"
          exit="exit"
          className="absolute inset-0 overflow-y-auto overscroll-contain"
        >
          <Routes location={location}>
            <Route index element={<ApprovalsInbox tab="pending" />} />
            <Route path="decided" element={<ApprovalsInbox tab="decided" />} />
            <Route path=":id" element={<ApprovalDetailPage />} />
          </Routes>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
