import { expect, it } from "vite-plus/test";

import { resolveServerBackedAppDisplayName } from "./branding.logic";

it.each([
  {
    baseName: "T3Factory",
    stage: "Preview",
    version: "0.1.5-preview.20261101.1",
    expected: "T3Factory (Preview)",
  },
  {
    baseName: "T3Factory",
    stage: "Preview",
    version: "0.1.5-nightly.20261101.1",
    expected: "T3Factory (Preview)",
  },
  {
    baseName: "T3 Code",
    stage: "Beta",
    version: "0.1.5-preview.20261101.1",
    expected: "T3 Code (Nightly)",
  },
  { baseName: "T3 Code", stage: "Beta", version: "0.1.5", expected: "T3 Code (Beta)" },
])(
  "keeps distribution branding when resolving $baseName $stage against $version",
  ({ baseName, stage, version, expected }) => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName,
        fallbackDisplayName: `${baseName} (${stage})`,
        fallbackStageLabel: stage,
        primaryServerVersion: version,
      }),
    ).toBe(expected);
  },
);
