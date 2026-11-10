import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../../ui/button";
import { TruncatedText } from "./atoms";

export interface PageHeaderCrumb {
  label: string;
  /** Opens that level. Omit on the last crumb, which is the current page. */
  onSelect?: () => void;
  /** An element to render the crumb as, such as a router link. */
  render?: ReactElement;
}

/**
 * The 56px header of a page: a title, or a breadcrumb (`Tasks › T-38 › T-38.2`) with a back
 * button, then a view switch and the page actions.
 */
export function PageHeader({
  title,
  breadcrumb,
  onBack,
  view,
  actions,
}: {
  title?: string;
  breadcrumb?: readonly PageHeaderCrumb[];
  onBack?: () => void;
  view?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex h-14 min-w-0 shrink-0 items-center gap-3 border-b border-border px-6">
      {onBack ? (
        <Button variant="ghost-muted" size="icon-xs" aria-label="Back" onClick={onBack}>
          <ChevronLeftIcon aria-hidden />
        </Button>
      ) : null}
      {breadcrumb && breadcrumb.length > 0 ? (
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1.5 text-sm">
            {breadcrumb.map((crumb, index) => {
              const current = index === breadcrumb.length - 1;
              return (
                <li
                  key={crumb.label}
                  className={cn("flex min-w-0 items-center gap-1.5", !current && "shrink-0")}
                >
                  {index > 0 ? (
                    <ChevronRightIcon
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : null}
                  {current ? (
                    <h1 aria-current="page" className="min-w-0 truncate font-medium">
                      {crumb.label}
                    </h1>
                  ) : (
                    <InlineButton
                      tone="muted"
                      onClick={crumb.onSelect}
                      {...(crumb.render ? { render: crumb.render } : {})}
                    >
                      {crumb.label}
                    </InlineButton>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : (
        <h1 className="flex min-w-0 flex-1 font-semibold text-base">
          <TruncatedText text={title ?? ""} />
        </h1>
      )}
      {view ? <div className="flex shrink-0 items-center">{view}</div> : null}
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Heading for a block on the task page (Sub-tasks, Runs, Related), with meta and one action. */
export function SectionHeader({
  title,
  meta,
  action,
}: {
  title: string;
  meta?: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
}) {
  return (
    <div className="flex h-8 min-w-0 items-center gap-2">
      <h2 className="shrink-0 font-medium text-sm">{title}</h2>
      {meta ? <span className="min-w-0 truncate text-muted-foreground text-xs">{meta}</span> : null}
      {action ? (
        <Button
          variant="ghost-muted"
          size="xs"
          className="ms-auto"
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

/** The properties rail: rows whose values start at the same x. */
export function PropertyList({ children }: { children: ReactNode }) {
  return <dl className="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] gap-y-1">{children}</dl>;
}

export function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="col-span-2 grid min-h-8 grid-cols-subgrid items-center">
      <dt className="truncate text-muted-foreground text-sm">{label}</dt>
      <dd className="flex min-w-0 items-center text-sm">{children}</dd>
    </div>
  );
}
