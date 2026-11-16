import type { ProviderOptionSelection } from "@t3tools/contracts";

import { SpeedControl, UltracodeControl } from "../../chat/ComposerModelEffort";
import type { TraitsSelectionInput } from "../../chat/TraitsPicker";
import { Button } from "../../ui/button";

/**
 * Under the pin picker's option column: the composer's speed controls, and the way back to the
 * model's own defaults once an option has been chosen.
 */
export function TaskModelOptionsFooter(props: {
  traits: TraitsSelectionInput | null;
  chosen: ReadonlyArray<ProviderOptionSelection> | undefined;
  onReset: () => void;
}) {
  const { traits, chosen, onReset } = props;
  const hasChosen = (chosen?.length ?? 0) > 0;
  // Always there, at one height: the popup opens above its trigger and must not grow after a pick.
  return (
    <div className="flex min-h-11 items-center gap-2 border-t border-border/70 bg-muted/40 px-3 py-2">
      {traits ? <SpeedControl traits={traits} /> : null}
      {traits ? <UltracodeControl traits={traits} /> : null}
      <div className="ms-auto">
        <Button variant="ghost-muted" size="compact" disabled={!hasChosen} onClick={onReset}>
          Use model defaults
        </Button>
      </div>
    </div>
  );
}
