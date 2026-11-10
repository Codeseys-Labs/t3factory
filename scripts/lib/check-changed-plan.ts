// Windows refuses a command line over 32,767 characters. Leave room for the
// executable path and any wrapper process vp hands these arguments to. Every
// platform uses the same budget, so a diff always splits the same way.
const BUDGET = 24_000;
// At worst every character is escaped, plus the quotes and a separating space.
const quotedLength = (argument: string) => argument.length * 2 + 3;

// Keeps order and fills each command up to the budget. An item over the budget
// gets a command of its own rather than being dropped; if the OS refuses it,
// the step fails with the spawn error.
const pack = <T>(items: ReadonlyArray<T>, length: (item: T) => number, budget: number) => {
  const commands: Array<Array<T>> = [];
  let used = 0;
  for (const item of items) {
    const size = length(item);
    const command = commands.at(-1);
    if (command !== undefined && used + size <= budget) {
      command.push(item);
      used += size;
    } else {
      commands.push([item]);
      used = size;
    }
  }
  return commands;
};

export function splitArguments(
  fixed: ReadonlyArray<string>,
  list: ReadonlyArray<string>,
  budget = BUDGET,
) {
  const room = fixed.reduce((left, argument) => left - quotedLength(argument), budget);
  return pack(list, quotedLength, room).map((chunk) => [...fixed, ...chunk]);
}

// The alternatives share one `-t` argument (the "" below), each adding itself
// and a "|". A command runs only the coverage files its alternatives come from,
// so mobile's `always` cases run once, with the mobile file.
export function splitCompilerPattern(
  apps: ReadonlyArray<{ test: string; pattern: ReadonlyArray<string> }>,
  budget = BUDGET,
) {
  const alternatives = apps.flatMap(({ test, pattern }) =>
    pattern.map((alternative) => ({ test, alternative })),
  );
  const room = ["test", "run", "-t", "", ...apps.map(({ test }) => test)].reduce(
    (left, argument) => left - quotedLength(argument),
    budget,
  );
  return pack(alternatives, ({ alternative }) => (alternative.length + 1) * 2, room).map(
    (chunk) => [
      "test",
      "run",
      ...new Set(chunk.map(({ test }) => test)),
      "-t",
      chunk.map(({ alternative }) => alternative).join("|"),
    ],
  );
}

const QUALIFICATION_CASES = "evals/factory-qualification/v1/cases.json";

// A missing or malformed cases.json pins nothing; changing it still counts.
export function touchesQualificationPin(
  files: ReadonlyArray<string>,
  read: (path: string) => string,
) {
  if (files.includes(QUALIFICATION_CASES)) return true;
  try {
    const cases: unknown = JSON.parse(read(QUALIFICATION_CASES));
    return (
      Array.isArray(cases) &&
      cases.some(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          "source" in entry &&
          typeof entry.source === "object" &&
          entry.source !== null &&
          "path" in entry.source &&
          typeof entry.source.path === "string" &&
          files.includes(entry.source.path),
      )
    );
  } catch {
    return false;
  }
}
