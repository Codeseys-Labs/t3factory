import { CheckIcon, PinIcon } from "lucide-react";
import { type ReactElement, useRef, useState } from "react";

import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../ui/command";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Separator } from "../../ui/separator";
import { Monogram } from "./atoms";

export type AssigneePickerValue =
  | { kind: "auto" }
  | { kind: "profile"; profileId: string }
  | { kind: "pinned" }
  | { kind: "person" }
  | { kind: "unassigned" };

export interface AssigneePickerProfile {
  id: string;
  name: string;
  /** Harness monogram, such as `Cx`. */
  mono: string;
  /** What the profile runs, such as `Codex · Sol`. */
  detail: string;
}

interface Option {
  key: string;
  value: AssigneePickerValue;
  label: string;
  detail: string;
  mono: string;
  auto?: boolean;
}

const PIN_KEY = "pin";

function valueKey(value: AssigneePickerValue): string {
  return value.kind === "profile" ? `profile:${value.profileId}` : value.kind;
}

function matches(option: Option, query: string): boolean {
  return `${option.label} ${option.detail}`.toLocaleLowerCase().includes(query);
}

/**
 * A searchable popover for choosing who does a task: Auto (with what it would pick), the agent
 * profiles, the signed-in person, and an entry that asks the caller to open the model picker to
 * pin a harness and model. `trigger` is the element that opens it, such as
 * `<AssigneeChip assignee={…} render={<button type="button" />} />`.
 */
export function AssigneePicker({
  trigger,
  open: controlledOpen,
  onOpenChange,
  auto,
  profiles,
  person,
  pinned,
  allowUnassigned = false,
  selected,
  onSelect,
  onPin,
}: {
  trigger: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** What Auto would pick, such as `Picks Claude · Opus for this project`. Null hides Auto. */
  auto: { detail: string } | null;
  profiles: readonly AssigneePickerProfile[];
  person: { label: string; initials: string; detail: string } | null;
  /** The pinned harness and model, shown while the task is pinned. */
  pinned?: { label: string; mono: string } | null;
  allowUnassigned?: boolean;
  selected: AssigneePickerValue | null;
  onSelect: (value: AssigneePickerValue) => void;
  onPin: () => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (!next) setQuery("");
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const agentOptions: Option[] = [
    ...(auto
      ? [
          {
            key: "auto",
            value: { kind: "auto" },
            label: "Auto",
            detail: auto.detail,
            mono: "Au",
            auto: true,
          } satisfies Option,
        ]
      : []),
    ...(pinned
      ? [
          {
            key: "pinned",
            value: { kind: "pinned" },
            label: pinned.label,
            detail: "Pinned",
            mono: pinned.mono,
          } satisfies Option,
        ]
      : []),
    ...profiles.map((profile): Option => ({
      key: `profile:${profile.id}`,
      value: { kind: "profile", profileId: profile.id },
      label: profile.name,
      detail: profile.detail,
      mono: profile.mono,
    })),
  ];
  const personOptions: Option[] = [
    ...(person
      ? [
          {
            key: "person",
            value: { kind: "person" },
            label: person.label,
            detail: person.detail,
            mono: person.initials,
          } satisfies Option,
        ]
      : []),
    ...(allowUnassigned
      ? [
          {
            key: "unassigned",
            value: { kind: "unassigned" },
            label: "Unassigned",
            detail: "Nobody yet",
            mono: "–",
          } satisfies Option,
        ]
      : []),
  ];
  const search = query.trim().toLocaleLowerCase();
  const visibleAgents = agentOptions.filter((option) => matches(option, search));
  const visiblePeople = personOptions.filter((option) => matches(option, search));
  const selectedKey = selected ? valueKey(selected) : null;

  const choose = (value: AssigneePickerValue) => {
    setOpen(false);
    onSelect(value);
  };

  const renderOption = (option: Option) => (
    <CommandItem key={option.key} value={option.key} onClick={() => choose(option.value)}>
      <Monogram text={option.mono} size="md" tone={option.auto ? "auto" : "default"} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{option.label}</span>
        <span className="truncate text-muted-foreground text-xs">{option.detail}</span>
      </span>
      {option.key === selectedKey ? (
        <CheckIcon aria-label="Selected" className="size-4 shrink-0 text-primary" />
      ) : null}
    </CommandItem>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverPopup align="start" padding="none" width="md" initialFocus={inputRef}>
        <Command mode="none" value={query} onValueChange={setQuery} aria-label="Choose an assignee">
          <CommandInput ref={inputRef} placeholder="Search assignee…" />
          <CommandList className="max-h-[min(30rem,var(--available-height))] overflow-y-auto">
            {visibleAgents.length === 0 && visiblePeople.length === 0 ? (
              <p className="px-3 py-4 text-center text-muted-foreground text-sm">
                No assignee matches “{query.trim()}”.
              </p>
            ) : null}
            {visibleAgents.map(renderOption)}
            {visiblePeople.length > 0 ? (
              <CommandGroup>
                <CommandGroupLabel>You</CommandGroupLabel>
                {visiblePeople.map(renderOption)}
              </CommandGroup>
            ) : null}
            <Separator className="my-1" />
            <CommandItem
              value={PIN_KEY}
              onClick={() => {
                setOpen(false);
                onPin();
              }}
            >
              <PinIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-muted-foreground text-sm">
                Pin a harness and model…
              </span>
            </CommandItem>
          </CommandList>
        </Command>
      </PopoverPopup>
    </Popover>
  );
}
