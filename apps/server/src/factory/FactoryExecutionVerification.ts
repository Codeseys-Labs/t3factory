// The engine keeps a code checkpoint only behind a check. This one changes nothing.
export const CHECKPOINT_VERIFICATION = {
  command: "git",
  args: ["rev-parse", "--verify", "HEAD"],
} as const;
