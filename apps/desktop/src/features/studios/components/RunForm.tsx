import { ArrowLeft, Eye, Play } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { ApiError } from "@/lib/api";
import type { Workspace } from "@/lib/types";
import { spring, transition } from "@/motion/tokens";
import { Button, Field, Input, Kbd, toast } from "@/ui";
import { FlowStrip, GateMark, type FlowStep } from "@/ui/flow";

import { createdTaskId, useCreateTask, useDbProfiles, useDeployProfiles, useHosts, useInstantiate, useRepos } from "../api";
import { buildTaskBody, defaultTitle, fieldKind, initialValues, requestInputs, resolvedSummary, serverFieldErrors, validateField, validateValues, type FormErrors, type FormValues } from "../form";
import { useShortcut } from "../hooks";
import { layoutGraph } from "../model";
import { studioStrings as s } from "../strings";
import type { FlowGraph, Studio, StudioInput } from "../types";
import { InputField } from "./InputField";

const stepVariants = {
  initial: (dir: number) => ({ opacity: 0, x: dir * 24 }),
  animate: { opacity: 1, x: 0, transition: { ...spring.smooth, opacity: transition.standard } },
  exit: (dir: number) => ({ opacity: 0, x: dir * -16, transition: transition.exit }),
};

/** Linear steps for the preview strip: graph nodes in layout order, control nodes left out. */
function previewSteps(graph: FlowGraph): FlowStep[] {
  const pos = layoutGraph(graph);
  return graph.nodes
    .filter((n) => !["parallel", "join", "condition"].includes(n.config.kind))
    .sort((a, b) => (pos.get(a.id)?.x ?? 0) - (pos.get(b.id)?.x ?? 0) || (pos.get(a.id)?.y ?? 0) - (pos.get(b.id)?.y ?? 0))
    .map(
      (n): FlowStep => ({
        id: n.id,
        label: n.label,
        kind: (["gate", "advisor", "merge", "human"] as const).find((k) => k === n.config.kind) ?? "agent",
        provider: n.config.provider === "claude" || n.config.provider === "codex" ? n.config.provider : undefined,
        status: "pending",
      }),
    );
}

/** Resolve picker ids to names for the preview ("repo_1" → "odeme-servisi"). */
function useDisplayValue(workspaceId: string, inputs: StudioInput[]) {
  const kinds = new Set(inputs.map(fieldKind));
  const repos = useRepos(kinds.has("repo") ? workspaceId : undefined);
  const hosts = useHosts(workspaceId, kinds.has("host"));
  const dbs = useDbProfiles(workspaceId, kinds.has("db"));
  const profiles = useDeployProfiles(workspaceId, kinds.has("deploy_profile"));
  return (input: StudioInput, value: string) => {
    const kind = fieldKind(input);
    const list: { id: string; name: string }[] | undefined =
      kind === "repo" ? repos.data : kind === "host" ? hosts.data : kind === "db" ? dbs.data : kind === "deploy_profile" ? profiles.data : undefined;
    return list?.find((x) => x.id === value)?.name ?? value;
  };
}

export function RunForm({ studio, workspace }: { studio: Studio; workspace: Workspace }) {
  const navigate = useNavigate();
  const inputs = useMemo(() => studio.inputs ?? [], [studio.inputs]);
  const [values, setValues] = useState<FormValues>(() => initialValues(inputs));
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [title, setTitle] = useState("");
  const [preview, setPreview] = useState<FlowGraph | null>(null);
  const [direction, setDirection] = useState(1);
  const instantiate = useInstantiate();
  const create = useCreateTask();
  const display = useDisplayValue(workspace.id, inputs);

  const change = (name: string, value: string) => {
    const next = { ...values, [name]: value };
    setValues(next);
    // Re-validate live once the user has tried to submit (errors disappear as they are fixed).
    const input = inputs.find((i) => i.name === name);
    if (submitted && input) setErrors((e) => ({ ...e, [name]: validateField(input, next) ?? "" }));
  };

  const goPreview = () => {
    setSubmitted(true);
    const local = validateValues(inputs, values);
    setErrors(local);
    if (Object.keys(local).length) {
      toast({ title: s.fixErrors, tone: "warning", id: "studio-run-errors" });
      document.getElementById(`studio-input-${Object.keys(local)[0]}`)?.focus();
      return;
    }
    instantiate.mutate(
      { studioId: studio.id, workspaceId: workspace.id, inputs: requestInputs(inputs, values) },
      {
        onSuccess: (graph) => {
          setDirection(1);
          setPreview(graph);
        },
        onError: (err) => {
          const fields = serverFieldErrors(err);
          if (Object.keys(fields).length) {
            setErrors(fields);
            toast({ title: s.fixErrors, tone: "warning", id: "studio-run-errors" });
          } else toast.error(s.instantiateFailed, { description: err instanceof ApiError ? err.message : undefined });
        },
      },
    );
  };

  const start = () => {
    const body = buildTaskBody(studio, values, workspace.id, title);
    create.mutate(body, {
      onSuccess: (res) => {
        toast.success(s.created, { description: body.title });
        void navigate(`/tasks/${encodeURIComponent(createdTaskId(res))}`);
      },
      onError: (err) => toast.error(s.createFailed, { description: err instanceof ApiError ? err.message : undefined }),
    });
  };

  const back = () => {
    setDirection(-1);
    setPreview(null);
  };

  useShortcut("⌘↵", () => (preview ? start() : goPreview()), !create.isPending && !instantiate.isPending);

  const steps = preview ? previewSteps(preview) : [];
  const summary = resolvedSummary(inputs, values, display);

  return (
    <div className="relative overflow-hidden">
      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        {preview ? (
          <motion.div key="preview" custom={direction} variants={stepVariants} initial="initial" animate="animate" exit="exit" className="flex flex-col gap-5">
            <div className="flex items-start gap-3">
              <GateMark status="passed" size={22} />
              <div className="flex flex-col gap-0.5">
                <h3 className="font-serif text-md text-fg">{s.previewTitle}</h3>
                <p className="text-xs text-fg-muted">{s.previewHint}</p>
              </div>
            </div>
            <dl className="flex flex-col divide-y divide-line-subtle rounded-lg border border-line bg-canvas-subtle">
              <div className="flex flex-col gap-0.5 px-3 py-2.5">
                <dt className="text-2xs font-medium text-fg-muted">{s.taskTitle}</dt>
                <dd className="text-sm text-fg">{title.trim() || defaultTitle(studio, values)}</dd>
              </div>
              {summary.map((row) => (
                <div key={row.name} className="flex flex-col gap-0.5 px-3 py-2.5">
                  <dt className="text-2xs font-medium text-fg-muted">{row.label}</dt>
                  <dd className={row.value ? "line-clamp-3 text-sm whitespace-pre-line text-fg" : "text-sm text-fg-faint"}>{row.value || s.empty}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-col gap-2">
              <span className="text-2xs font-medium text-fg-muted">{s.nodesBound(preview.nodes.length)}</span>
              <FlowStrip steps={steps} size="sm" aria-label={s.flow} />
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <Button variant="ghost" icon={<ArrowLeft />} onClick={back} disabled={create.isPending}>
                {s.editInputs}
              </Button>
              <Button variant="primary" icon={<Play />} loading={create.isPending} onClick={start} iconRight={<Kbd shortcut="⌘↵" tone="accent" className="ml-1" />}>
                {s.start}
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            custom={direction}
            variants={stepVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              goPreview();
            }}
            className="flex flex-col gap-4"
          >
            {inputs.map((input) => (
              <InputField
                key={input.name}
                input={input}
                inputs={inputs}
                values={values}
                error={errors[input.name] || null}
                workspaceId={workspace.id}
                onChange={change}
              />
            ))}
            <Field label={<span>{s.taskTitle} <span className="font-normal text-fg-faint">· {s.optional}</span></span>} htmlFor="studio-run-title" hint={s.taskTitleHint}>
              <Input id="studio-run-title" value={title} placeholder={defaultTitle(studio, values)} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <div className="flex items-center justify-end gap-3 pt-1">
              <Button type="submit" variant="primary" icon={<Eye />} loading={instantiate.isPending} iconRight={<Kbd shortcut="⌘↵" tone="accent" className="ml-1" />}>
                {s.preview}
              </Button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}
