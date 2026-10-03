/**
 * Shared UI kit (spec §20 "Bileşenler"). Import from "@/ui"; flow visuals from "@/ui/flow".
 * Every component takes Turkish defaults from ./strings and is themed only through tokens.
 */
export { cn } from "./cn";
export { uiStrings } from "./strings";

// Actions
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";
export { IconButton, type IconButtonProps } from "./IconButton";
export { CopyButton, type CopyButtonProps } from "./CopyButton";

// Form controls
export { Input, Field, type InputProps, type FieldProps } from "./Input";
export { Textarea, type TextareaProps } from "./Textarea";
export { Select, type SelectOption, type SelectProps } from "./Select";
export { Switch, type SwitchProps } from "./Switch";
export { Checkbox, type CheckboxProps, type CheckedState } from "./Checkbox";
export { SegmentedControl, type SegmentedControlProps, type SegmentedOption } from "./SegmentedControl";
export { Tabs, TabsContent, TabsList, TabsTrigger, type TabsProps, type TabsTriggerProps } from "./Tabs";

// Display
export { Badge, type BadgeProps, type BadgeTone, type BadgeVariant } from "./Badge";
export { Kbd, type KbdProps } from "./Kbd";
export { Card, CardFooter, CardHeader, type CardProps } from "./Card";
export { Divider, type DividerProps } from "./Divider";
export { ScrollArea, type ScrollAreaProps } from "./ScrollArea";
export { Skeleton, SkeletonText, type SkeletonProps } from "./Skeleton";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { Spinner, type SpinnerProps } from "./Spinner";
export { ProgressBar, type ProgressBarProps } from "./ProgressBar";
export { LimitBar, type LimitBarProps } from "./LimitBar";
export { StatusDot, type DotStatus, type StatusDotProps } from "./StatusDot";
export { EnvBadge, type EnvBadgeProps } from "./EnvBadge";
export { ProviderMark, type ProviderMarkProps } from "./ProviderMark";
export { AgentCard, type AgentCardProps } from "./AgentCard";
export { AnimatedNumber, type AnimatedNumberProps } from "./AnimatedNumber";
export { CountBadge, type CountBadgeProps } from "./CountBadge";
export { Timeline, TimelineItem, type TimelineItemProps, type TimelineProps } from "./Timeline";

// Overlays
export { Tooltip, TooltipProvider, type TooltipProps } from "./Tooltip";
export { Popover, HoverCard, type HoverCardProps, type PopoverProps } from "./Popover";
export {
  Menu,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  type MenuItemProps,
  type MenuProps,
} from "./Menu";
export { Dialog, Sheet, type DialogProps } from "./Dialog";
export { Drawer, type DrawerProps } from "./Drawer";
export { Toaster } from "./toast/Toaster";
export { toast, useToasts, type ToastOptions, type ToastTone } from "./toast/store";
export { ThemeScope, type ThemeScopeProps } from "./ThemeScope";

// Code & text
export { CodeBlock, type CodeBlockProps } from "./CodeBlock";
export { DiffView, type DiffViewProps } from "./DiffView";
export { MarkdownView, type MarkdownViewProps } from "./MarkdownView";
export { LogView, type LogLine, type LogViewProps } from "./LogView";

// Helpers
export { agentDotStatus, isAgentBusy } from "./agentStatus";
export { clampPercent, groupLimits, limitTone, resetCountdown, LIMIT_CRITICAL_AT, LIMIT_WARN_AT, type LimitTone } from "./limits";
export { isMacPlatform, isTypingTarget, matchesShortcut, parseShortcut, shortcutKeys } from "./shortcuts";
export { parseAnsi, stripAnsi } from "./log/ansi";
export { parseMarkdown } from "./markdown/parse";
export { usePortalContainer } from "./portal";
