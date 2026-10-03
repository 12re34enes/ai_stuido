/**
 * Ad-hoc session dialog: provider, profile, location, repo/cwd, model and an optional first
 * message → `POST /api/agents/sessions`, then opens the session.
 */
import { FolderGit2, Laptop, Server } from "lucide-react";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";

import { ApiError } from "@/lib/api";
import type { Provider } from "@/lib/types";
import { useCurrentWorkspace } from "@/lib/workspace";
import { Button, Dialog, Field, Input, ProviderMark, SegmentedControl, Select, Textarea, toast, uiStrings } from "@/ui";

import { useProfiles, useRemoteHosts, useRepos, useStartSession } from "./api";
import { sessionStrings as t } from "./strings";

const c = t.create;
const LOCAL = "__local";
const NONE = "__none";

export function NewSessionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const { workspace } = useCurrentWorkspace();
  const profiles = useProfiles(workspace?.id ?? null);
  const hosts = useRemoteHosts();
  const repos = useRepos(workspace?.id ?? null);
  const start = useStartSession();
  const ids = { cwd: useId(), model: useId(), prompt: useId(), profile: useId(), location: useId(), repo: useId() };

  const [provider, setProvider] = useState<Provider>("claude");
  const [profileId, setProfileId] = useState<string>(NONE);
  const [location, setLocation] = useState<string>(LOCAL);
  const [repoId, setRepoId] = useState<string>(NONE);
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [touched, setTouched] = useState(false);

  const providerProfiles = useMemo(() => (profiles.data ?? []).filter((p) => p.provider === provider), [profiles.data, provider]);
  const profile = providerProfiles.find((p) => p.id === profileId);
  const hostId = location === LOCAL ? null : location;
  const locationRepos = useMemo(() => (repos.data ?? []).filter((r) => (r.host_id ?? null) === hostId), [hostId, repos.data]);

  const reset = () => {
    setProfileId(NONE);
    setRepoId(NONE);
    setCwd("");
    setModel("");
    setPrompt("");
    setTouched(false);
  };

  const cwdError = touched && !cwd.trim() ? c.cwdRequired : undefined;

  const submit = () => {
    setTouched(true);
    if (!workspace) {
      toast.error(c.failed, { description: c.noWorkspace });
      return;
    }
    if (!cwd.trim()) return;
    start.mutate(
      {
        workspace_id: workspace.id,
        profile_id: profile?.id ?? null,
        spec: {
          provider,
          cwd: cwd.trim(),
          location: { kind: hostId ? "remote" : "local", host_id: hostId },
          model: model.trim() || null,
        },
        initial_prompt: prompt.trim() || null,
      },
      {
        onSuccess: (s) => {
          toast.success(c.started, { description: s.label ?? undefined });
          onOpenChange(false);
          reset();
          void navigate(`/sessions/${s.id}`);
        },
        onError: (err) => toast.error(c.failed, { description: err instanceof ApiError ? err.message : undefined }),
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={c.title}
      description={c.description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {c.cancel}
          </Button>
          <Button variant="primary" loading={start.isPending} onClick={submit}>
            {c.submit}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-0.5" onKeyDown={onKeyDown}>
        <Field label={c.provider}>
          <SegmentedControl
            fullWidth
            aria-label={c.provider}
            value={provider}
            onValueChange={(v) => {
              setProvider(v);
              setProfileId(NONE);
            }}
            options={(["claude", "codex"] as const).map((p) => ({
              value: p,
              label: uiStrings.providers[p],
              icon: <ProviderMark provider={p} size={14} label="" />,
            }))}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={c.profile} htmlFor={ids.profile}>
            <Select
              id={ids.profile}
              aria-label={c.profile}
              value={profileId}
              onValueChange={setProfileId}
              options={[
                { value: NONE, label: c.noProfile },
                ...providerProfiles.map((p) => ({
                  value: p.id,
                  label: p.name,
                  description: [p.model, uiStrings.agentRole[p.role]].filter(Boolean).join(" · "),
                })),
              ]}
            />
          </Field>
          <Field label={c.location} htmlFor={ids.location}>
            <Select
              id={ids.location}
              aria-label={c.location}
              value={location}
              onValueChange={(v) => {
                setLocation(v);
                setRepoId(NONE);
              }}
              options={[
                { value: LOCAL, label: c.localMac, icon: <Laptop /> },
                ...(hosts.data ?? []).map((h) => ({ value: h.id, label: h.name, description: `${h.username}@${h.hostname}`, icon: <Server /> })),
              ]}
            />
          </Field>
        </div>
        {locationRepos.length > 0 && (
          <Field label={c.repo} htmlFor={ids.repo}>
            <Select
              id={ids.repo}
              aria-label={c.repo}
              value={repoId}
              onValueChange={(v) => {
                setRepoId(v);
                const repo = locationRepos.find((r) => r.id === v);
                if (repo) setCwd(repo.path);
              }}
              options={[
                { value: NONE, label: c.noRepo },
                ...locationRepos.map((r) => ({ value: r.id, label: r.name, description: r.path, icon: <FolderGit2 /> })),
              ]}
            />
          </Field>
        )}
        <Field label={c.cwd} htmlFor={ids.cwd} required error={cwdError}>
          <Input
            id={ids.cwd}
            value={cwd}
            invalid={Boolean(cwdError)}
            onChange={(e) => {
              setCwd(e.target.value);
              setRepoId(NONE);
            }}
            placeholder={c.cwdPlaceholder}
            className="font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <Field label={c.model} htmlFor={ids.model}>
          <Input
            id={ids.model}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={profile?.model ?? c.modelPlaceholder}
            className="font-mono text-xs"
            spellCheck={false}
          />
        </Field>
        <Field label={c.prompt} htmlFor={ids.prompt}>
          <Textarea id={ids.prompt} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={c.promptPlaceholder} minRows={3} maxRows={8} />
        </Field>
      </div>
    </Dialog>
  );
}
