import { describe, expect, it } from "vite-plus/test";

import {
  splitArguments,
  splitCompilerPattern,
  touchesQualificationPin,
} from "./check-changed-plan.ts";

describe("splitArguments", () => {
  it("keeps a short list in one command", () => {
    expect(splitArguments(["fmt", "--check"], ["a.ts", "b.ts"])).toEqual([
      ["fmt", "--check", "a.ts", "b.ts"],
    ]);
  });

  it("fills each command up to the budget, in order", () => {
    // At worst-case quoting "fmt" costs 9 and each four-character path 11.
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    expect(splitArguments(["fmt"], files, 31)).toEqual([
      ["fmt", "a.ts", "b.ts"],
      ["fmt", "c.ts", "d.ts"],
      ["fmt", "e.ts"],
    ]);
    expect(splitArguments(["fmt"], files, 30)).toEqual(files.map((file) => ["fmt", file]));
  });

  it("gives an argument over the budget a command of its own", () => {
    const long = "x".repeat(40);
    expect(splitArguments(["fmt"], ["a.ts", long, "b.ts", "c.ts"], 31)).toEqual([
      ["fmt", "a.ts"],
      ["fmt", long],
      ["fmt", "b.ts", "c.ts"],
    ]);
  });

  it("keeps a 653-file diff under the Windows command-line limit", () => {
    const name = `${"Module".repeat(8)}.test.ts`;
    const files = Array.from({ length: 653 }, (_, index) => `apps/web/${index}/${name}`);
    expect(files.join(" ").length).toBeGreaterThan(32_767);
    const commands = splitArguments(["test", "run", "--passWithNoTests"], files);
    expect(commands.length).toBeGreaterThan(1);
    for (const args of commands) {
      expect(args.slice(0, 3)).toEqual(["test", "run", "--passWithNoTests"]);
      expect(["vp", ...args].join(" ").length).toBeLessThan(32_767);
    }
    expect(commands.flatMap((args) => args.slice(3))).toEqual(files);
  });
});

describe("splitCompilerPattern", () => {
  const always = "^(?!.*compiles )";
  const apps = [
    { test: "web.test.ts", pattern: ["a$", "b$"] },
    { test: "mobile.test.ts", pattern: ["c$", always] },
  ];

  it("keeps a short pattern in one command over every coverage file", () => {
    expect(splitCompilerPattern(apps)).toEqual([
      ["test", "run", "web.test.ts", "mobile.test.ts", "-t", `a$|b$|c$|${always}`],
    ]);
  });

  it("splits the pattern in order, each part with its own coverage file", () => {
    expect(splitCompilerPattern(apps, 99)).toEqual([
      ["test", "run", "web.test.ts", "-t", "a$|b$"],
      ["test", "run", "mobile.test.ts", "-t", "c$"],
      ["test", "run", "mobile.test.ts", "-t", always],
    ]);
  });
});

describe("touchesQualificationPin", () => {
  const cases = "evals/factory-qualification/v1/cases.json";
  const pinned = "apps/server/src/factory/FactoryDeliveryService.test.ts";
  const read = (path: string) => {
    expect(path).toBe(cases);
    return JSON.stringify([
      { source: { path: "evals/test-signal/cases.ts" } },
      { source: { path: pinned } },
    ]);
  };
  const missing = () => {
    throw new Error("ENOENT: no such file or directory");
  };

  it("selects the check for a pinned file or the cases themselves", () => {
    expect(touchesQualificationPin(["README.md", pinned], read)).toBe(true);
    expect(touchesQualificationPin([cases], missing)).toBe(true);
    expect(touchesQualificationPin(["apps/server/src/factory/Unpinned.ts"], read)).toBe(false);
  });

  it("treats missing or malformed cases as pinning nothing", () => {
    for (const unreadable of [missing, () => "{", () => "{}", () => '[null, {"source": "x"}]']) {
      expect(touchesQualificationPin([pinned], unreadable)).toBe(false);
    }
  });
});
