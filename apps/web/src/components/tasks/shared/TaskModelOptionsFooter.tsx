import type { ProviderOptionSelection } from "@t3tools/contracts";

import { SpeedControl, UltracodeControl } from "../../chat/ComposerModelEffort";
import { getTraitsSectionVisibility, type TraitsSelectionInput } from "../../chat/TraitsPicker";
import { Button } from "../../ui/button";

const SPEED_OPTION_IDS: ReadonlySet<string> = new Set(["fastMode", "serviceTier", "ultracode"]);

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
  const hasSpeed =
    traits !== null &&
    getTraitsSectionVisibility(traits).descriptors.some((descriptor) =>
      SPEED_OPTION_IDS.has(descriptor.id),
    );
  const hasChosen = (chosen?.length ?? 0) > 0;
  if (!hasSpeed && !hasChosen) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/70 bg-muted/40 px-3 py-2">
      {traits ? <SpeedControl traits={traits} /> : null}
      {traits ? <UltracodeControl traits={traits} /> : null}
      {hasChosen ? (
        <div className="ms-auto">
          <Button variant="ghost-muted" size="compact" onClick={onReset}>
            Use model defaults
          </Button>
        </div>
      ) : null}
    </div>
  );
}
