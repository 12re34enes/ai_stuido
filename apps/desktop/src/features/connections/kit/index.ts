/**
 * Connection-specific primitives (targets, environments, permissions). The generic page scaffolding
 * moved to "@/ui" and is re-exported here so feature imports stay short.
 */
export {
  BackLink,
  Callout,
  ConfirmDialog,
  errorMessage,
  ErrorState,
  FormGroupLabel,
  KEEP,
  KeyValueList,
  ListSkeleton,
  PageBody,
  PageHeader,
  SecretField,
  secretPayload,
  Section,
  SettingRow,
  type CalloutTone,
  type ConfirmDialogProps,
  type SecretDraft,
  type SecretFieldProps,
} from "@/ui";
export { ClassBadge, EnvIcon, PermissionBadge, RunStatusBadge, TargetIcon } from "./badges";
export { EnvGroups, TargetRow } from "./TargetRow";
export { useDebounced, useScrollTopOnMount } from "./hooks";
export { EnvironmentPicker, PermissionPicker } from "./pickers";
