export function canRetryFactoryAttempt(input: {
  readonly status: "idle" | "running" | "held" | "failed" | "sealed";
  readonly hold: string | null;
  readonly grantActive: boolean;
  readonly taskGranted: boolean;
  readonly quiescent: boolean;
  readonly permitted: boolean;
}): boolean {
  return input.status === "failed" && input.hold === null && input.grantActive && input.taskGranted && input.quiescent && input.permitted;
}

export function hasCompleteAbsenceOfAttemptOutput(input: {
  readonly waiting: boolean;
  readonly nextPage: string | null;
  readonly seenOnEarlierPages: boolean;
  readonly seenOnCurrentPage: boolean;
}): boolean {
  return !input.waiting && input.nextPage === null && !input.seenOnEarlierPages && !input.seenOnCurrentPage;
}
