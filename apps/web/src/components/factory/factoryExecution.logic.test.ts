import { expect, it } from "vite-plus/test";
import { canRetryFactoryAttempt, hasCompleteAbsenceOfAttemptOutput } from "./factoryExecution.logic";

it("only offers a no-result retry after a failed attempt is quiescent and all result pages are read", () => {
  const eligible = { status: "failed" as const, hold: null, grantActive: true, taskGranted: true, quiescent: true, permitted: true };
  const absent = { waiting: false, nextPage: null, seenOnEarlierPages: false, seenOnCurrentPage: false };
  expect(canRetryFactoryAttempt(eligible)).toBe(true);
  expect(canRetryFactoryAttempt({ ...eligible, status: "held" })).toBe(false);
  expect(canRetryFactoryAttempt({ ...eligible, hold: "capture pending" })).toBe(false);
  expect(canRetryFactoryAttempt({ ...eligible, quiescent: false })).toBe(false);
  expect(canRetryFactoryAttempt({ ...eligible, grantActive: false })).toBe(false);
  expect(hasCompleteAbsenceOfAttemptOutput(absent)).toBe(true);
  expect(hasCompleteAbsenceOfAttemptOutput({ ...absent, nextPage: "later" })).toBe(false);
  expect(hasCompleteAbsenceOfAttemptOutput({ ...absent, seenOnEarlierPages: true })).toBe(false);
  expect(hasCompleteAbsenceOfAttemptOutput({ ...absent, seenOnCurrentPage: true })).toBe(false);
  expect(hasCompleteAbsenceOfAttemptOutput({ ...absent, waiting: true })).toBe(false);
});
