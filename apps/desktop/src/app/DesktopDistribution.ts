// Packaging compiles the distribution in; development and upstream builds stay "t3code".
declare const __T3CODE_DESKTOP_DISTRIBUTION__: string | undefined;

export const DESKTOP_DISTRIBUTIONS = ["t3code", "factory-preview"] as const;
export type DesktopDistribution = (typeof DESKTOP_DISTRIBUTIONS)[number];

export const FACTORY_PREVIEW_IDENTITY = {
  appId: "io.github.baladithyab.t3factory",
  productName: "T3Factory (Preview)",
  baseName: "T3Factory",
  artifactPrefix: "T3Factory-",
  scheme: "t3factory",
  userDataDirectoryName: "t3factory",
  homeDirectoryName: ".t3factory",
} as const;

export function isDesktopDistribution(value: string): value is DesktopDistribution {
  return (DESKTOP_DISTRIBUTIONS as ReadonlyArray<string>).includes(value);
}

export const bundledDesktopDistribution: DesktopDistribution =
  typeof __T3CODE_DESKTOP_DISTRIBUTION__ !== "undefined" &&
  __T3CODE_DESKTOP_DISTRIBUTION__ === "factory-preview"
    ? "factory-preview"
    : "t3code";
