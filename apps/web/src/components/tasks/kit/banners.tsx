import {
  CheckIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleIcon,
  CirclePlayIcon,
  CircleXIcon,
  EyeIcon,
  ListChecksIcon,
  LockIcon,
  type LucideIcon,
  SendIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Button, type ButtonVariant } from "../../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../ui/input-group";

export interface KitAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** `primary` is the next step, `secondary` an alternative, `danger` stop or deny. */
  tone?: "primary" | "secondary" | "danger";
}

const ACTION_VARIANTS: Record<NonNullable<KitAction["tone"]>, ButtonVariant> = {
  primary: "default",
  secondary: "outline",
  danger: "destructive-outline",
};

export function KitActionButton({
  action,
  defaultTone = "secondary",
  size = "sm",
}: {
  action: KitAction;
  defaultTone?: NonNullable<KitAction["tone"]>;
  size?: "sm" | "xs";
}) {
  return (
    <Button
      variant={ACTION_VARIANTS[action.tone ?? defaultTone]}
      size={size}
      disabled={action.disabled}
      onClick={action.onClick}
    >
      {action.label}
    </Button>
  );
}

type Surface = "neutral" | "attention" | "info" | "success" | "error";

/** Amber `attention` is the same surface the Question and Approval cards use. */
const SURFACE_CLASSES: Record<Surface, string> = {
  neutral: "border-border bg-card",
  attention: "border-warning/32 bg-warning-surface",
  info: "border-info/24 bg-info/8",
  success: "border-success/24 bg-success/8",
  error: "border-destructive/32 bg-error-surface",
};

export type StatusBannerState =
  | "backlog"
  | "ready"
  | "blocked"
  | "plan-proposed"
  | "in-progress"
  | "needs-you"
  | "in-review"
  | "done"
  | "failed";

const BANNER_VISUALS: Record<
  StatusBannerState,
  { Icon: LucideIcon; surface: Surface; iconClass: string }
> = {
  backlog: { Icon: CircleDashedIcon, surface: "neutral", iconClass: "text-muted-foreground" },
  ready: { Icon: CircleIcon, surface: "neutral", iconClass: "text-foreground" },
  blocked: { Icon: LockIcon, surface: "neutral", iconClass: "text-muted-foreground" },
  "plan-proposed": {
    Icon: ListChecksIcon,
    surface: "attention",
    iconClass: "text-warning-foreground",
  },
  "in-progress": {
    Icon: CirclePlayIcon,
    surface: "info",
    iconClass: "text-sky-600 dark:text-sky-300/80",
  },
  "needs-you": { Icon: CircleHelpIcon, surface: "attention", iconClass: "text-warning-foreground" },
  "in-review": { Icon: EyeIcon, surface: "attention", iconClass: "text-warning-foreground" },
  done: {
    Icon: CircleCheckIcon,
    surface: "success",
    iconClass: "text-emerald-600 dark:text-emerald-300/90",
  },
  failed: { Icon: CircleXIcon, surface: "error", iconClass: "text-destructive-foreground" },
};

/**
 * The strip under the task title: where the task stands and the action that fits. The primary
 * action defaults to the primary tone and the secondary one to the secondary tone.
 */
export function StatusBanner({
  state,
  headline,
  detail,
  primary,
  secondary,
}: {
  state: StatusBannerState;
  headline: string;
  detail?: string;
  primary?: KitAction;
  secondary?: KitAction;
}) {
  const visual = BANNER_VISUALS[state];
  return (
    <section
      aria-label={headline}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-lg border px-4 py-3",
        SURFACE_CLASSES[visual.surface],
      )}
    >
      <visual.Icon aria-hidden className={cn("size-4 shrink-0", visual.iconClass)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="truncate font-medium text-sm">{headline}</p>
        {detail ? <p className="truncate text-muted-foreground text-xs">{detail}</p> : null}
      </div>
      {secondary || primary ? (
        <div className="flex shrink-0 items-center gap-2">
          {secondary ? <KitActionButton action={secondary} /> : null}
          {primary ? <KitActionButton action={primary} defaultTone="primary" /> : null}
        </div>
      ) : null}
    </section>
  );
}

function AskHeader({ Icon, from, verb }: { Icon: LucideIcon; from: string; verb: string }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs">
      <Icon aria-hidden className="size-3.5 shrink-0 text-warning-foreground" />
      <span className="min-w-0 truncate font-medium text-warning-foreground">{from}</span>
      <span className="shrink-0 text-muted-foreground">{verb}</span>
    </p>
  );
}

export interface QuestionAnswer {
  optionId: string | null;
  text: string;
}

/**
 * An agent's question: its options with a visible selection, a free-text reply, and Send. Send
 * passes the chosen option, the typed text, or both.
 */
export function QuestionCard({
  from,
  question,
  options,
  placeholder = "Or write a reply…",
  pending = false,
  onSend,
}: {
  from: string;
  question: string;
  options: readonly { id: string; label: string }[];
  placeholder?: string;
  pending?: boolean;
  onSend: (answer: QuestionAnswer) => void;
}) {
  const [optionId, setOptionId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const canSend = !pending && (optionId !== null || text.trim().length > 0);
  const send = () => {
    if (canSend) onSend({ optionId, text: text.trim() });
  };
  return (
    <section
      aria-label={`${from} asks`}
      className={cn("flex min-w-0 flex-col gap-3 rounded-lg border p-4", SURFACE_CLASSES.attention)}
    >
      <AskHeader Icon={CircleHelpIcon} from={from} verb="asks" />
      <p className="text-sm">{question}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {options.map((option) => {
          const selected = option.id === optionId;
          return (
            <Button
              key={option.id}
              variant="outline"
              size="sm"
              aria-pressed={selected}
              data-pressed={selected ? "" : undefined}
              disabled={pending}
              onClick={() => setOptionId(selected ? null : option.id)}
            >
              {selected ? <CheckIcon aria-hidden /> : null}
              {option.label}
            </Button>
          );
        })}
        <InputGroup className="min-w-48 flex-1">
          <InputGroupInput
            aria-label="Reply"
            size="sm"
            placeholder={placeholder}
            value={text}
            disabled={pending}
            onChange={(event) => setText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Send"
              disabled={!canSend}
              onClick={send}
            >
              <SendIcon aria-hidden />
            </Button>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </section>
  );
}

/** An agent asks to run a command: who asks, the exact command, where it runs, and the answers. */
export function ApprovalCard({
  from,
  command,
  detail,
  pending = false,
  onApproveOnce,
  onAlwaysAllow,
  onDeny,
}: {
  from: string;
  command: string;
  detail?: string;
  pending?: boolean;
  onApproveOnce: () => void;
  /** Omit when the run cannot remember the answer for this task. */
  onAlwaysAllow?: () => void;
  onDeny: () => void;
}) {
  return (
    <section
      aria-label={`${from} wants to run a command`}
      className={cn("flex min-w-0 flex-col gap-3 rounded-lg border p-4", SURFACE_CLASSES.attention)}
    >
      <AskHeader Icon={ShieldCheckIcon} from={from} verb="wants to run" />
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-background px-3 py-2 font-mono text-xs">
        {command}
      </pre>
      {detail ? <p className="truncate text-muted-foreground text-xs">{detail}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pending} onClick={onApproveOnce}>
          Approve once
        </Button>
        {onAlwaysAllow ? (
          <Button variant="outline" size="sm" disabled={pending} onClick={onAlwaysAllow}>
            Always allow for this task
          </Button>
        ) : null}
        <Button variant="destructive-outline" size="sm" disabled={pending} onClick={onDeny}>
          Deny
        </Button>
      </div>
    </section>
  );
}
