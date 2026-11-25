#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

type Catalog = Readonly<Record<string, Schema.Json>>;
const CatalogJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
const decodeCatalog = Schema.decodeUnknownEffect(CatalogJson);
const apps = ["web", "mobile", "desktop"] as const;
type App = (typeof apps)[number];

const formatValue = (value: Schema.Json | undefined, indent: string, newline: string): string =>
  (JSON.stringify(value, null, 2) ?? "null").replaceAll("\n", `${newline}${indent}`);
const displayValue = (value: Schema.Json | undefined): string =>
  JSON.stringify(value) ?? "undefined";

const formatSource = (source: Catalog): string => {
  const lines = Object.keys(source)
    .sort()
    .map((key) => `  ${JSON.stringify(key)}: ${formatValue(source[key], "  ", "\n")}`);
  return lines.length ? `{\n${lines.join(",\n")}\n}\n` : "{}\n";
};

export const jsonEqual = (
  left: Schema.Json | undefined,
  right: Schema.Json | undefined,
): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) ||
    Array.isArray(right)
  )
    return false;
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) && jsonEqual(Reflect.get(left, key), Reflect.get(right, key)),
    )
  );
};

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

interface TranslationSlot {
  readonly identity: Schema.Json;
  readonly branches: Schema.JsonObject | undefined;
  readonly namedBranches: boolean;
}

const translationParts = (value: Schema.Json | undefined) => {
  const slots: TranslationSlot[] = [];
  const placeholders = new Set<string>();
  const visit = (part: Schema.Json | undefined): void => {
    if (typeof part === "string") {
      let depth = 0;
      for (let index = 0; index < part.length; index++) {
        if (part[index] === "{") {
          if (depth === 0) {
            const name = part.slice(index + 1).match(/^\s*([^,\s{}]+)/)?.[1];
            if (name) placeholders.add(name);
          }
          depth++;
        } else if (part[index] === "}" && depth > 0) {
          depth--;
        }
      }
    } else if (Array.isArray(part)) {
      for (const child of part) visit(child);
    } else if (part !== null && typeof part === "object") {
      const data = Reflect.get(part, "d");
      const branches = isJsonObject(data) && isJsonObject(data.b) ? data.b : undefined;
      const identity = Object.fromEntries(
        Object.entries(part).filter(
          ([key]) => key !== "c" && (key !== "d" || branches === undefined),
        ),
      );
      if (branches !== undefined && isJsonObject(data)) {
        identity.d = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "b"));
      }
      slots.push({ identity, branches, namedBranches: isJsonObject(data) && data.t === "b" });
      if (Object.hasOwn(part, "c")) visit(Reflect.get(part, "c"));
    }
  };
  visit(value);
  return { slots, placeholders };
};

const matchingSlots = (
  source: ReadonlyArray<TranslationSlot>,
  target: ReadonlyArray<TranslationSlot>,
): boolean => {
  if (source.length !== target.length) return false;
  if (source.length === 0) return true;
  const [first, ...rest] = source;
  if (first === undefined) return true;
  return target.some((candidate, index) => {
    if (!jsonEqual(first.identity, candidate.identity)) return false;
    if (first.branches !== undefined || candidate.branches !== undefined) {
      if (first.branches === undefined || candidate.branches === undefined) return false;
      const original = first.branches;
      const translated = candidate.branches;
      const sourceNames = Object.keys(original);
      const targetNames = Object.keys(translated);
      if (
        targetNames.length === 0 ||
        (first.namedBranches &&
          (sourceNames.length !== targetNames.length ||
            sourceNames.some((name) => !Object.hasOwn(translated, name))))
      ) {
        return false;
      }
      if (
        !targetNames.every((name) =>
          sourceNames.some((sourceName) =>
            matchingSlots(
              translationParts(original[sourceName]).slots,
              translationParts(translated[name]).slots,
            ),
          ),
        )
      )
        return false;
    }
    return matchingSlots(
      rest,
      target.filter((_, candidateIndex) => candidateIndex !== index),
    );
  });
};

export const sameTranslationSlots = (
  english: Schema.Json | undefined,
  translation: Schema.Json | undefined,
): boolean => {
  if ((typeof english === "string") !== (typeof translation === "string")) return false;
  const source = translationParts(english);
  const target = translationParts(translation);
  if (
    source.placeholders.size !== target.placeholders.size ||
    [...source.placeholders].some((name) => !target.placeholders.has(name)) ||
    !matchingSlots(source.slots, target.slots)
  )
    return false;
  return true;
};

export const missingTranslationKeys = (keys: ReadonlyArray<string>, overlay: Catalog): string[] =>
  keys.filter((key) => !Object.hasOwn(overlay, key));

export const forkKeys = (upstreamEn: Catalog, generatedEn: Catalog): string[] =>
  Object.keys(generatedEn)
    .filter((key) => !Object.hasOwn(upstreamEn, key))
    .sort();

export const pruneAdoptedOverlayKeys = (overlay: Catalog, upstreamEn: Catalog): Catalog =>
  Object.fromEntries(Object.entries(overlay).filter(([key]) => !Object.hasOwn(upstreamEn, key)));

export const mergeCatalogText = (upstreamText: string, entries: Catalog): string => {
  const keys = Object.keys(entries).sort();
  if (keys.length === 0) return upstreamText;
  const end = upstreamText.lastIndexOf("}");
  if (end < 0) throw new Error("Invalid upstream catalog");
  const before = upstreamText.slice(0, end);
  const last = before.search(/\s*$/);
  const body = before.slice(0, last);
  const trailing = before.slice(last);
  const newline = upstreamText.includes("\r\n") ? "\r\n" : "\n";
  const indent = upstreamText.match(/(?:^|\n)([ \t]+)"/)?.[1] ?? "  ";
  const separator = upstreamText.match(/"\s*:(\s*)"/)?.[1] ?? " ";
  const lines = keys.map(
    (key) =>
      `${indent}${JSON.stringify(key)}:${separator}${formatValue(entries[key], indent, newline)}`,
  );
  const hasEntries = body.trim() !== "{";
  return `${body}${hasEntries ? "," : ""}${newline}${lines.join(`,${newline}`)}${trailing || newline}${upstreamText.slice(end)}`;
};

export const checkCatalogText = (
  upstreamText: string,
  currentText: string,
  keys: ReadonlyArray<string>,
): boolean => {
  try {
    const current: unknown = JSON.parse(currentText);
    if (typeof current !== "object" || current === null || Array.isArray(current)) return false;
    const entries: Record<string, Schema.Json> = {};
    for (const key of keys) {
      if (!Object.hasOwn(current, key)) return false;
      entries[key] = Reflect.get(current, key);
    }
    return mergeCatalogText(upstreamText, entries) === currentText;
  } catch {
    return false;
  }
};

export class FactoryI18nError extends Schema.TaggedError<FactoryI18nError>()("FactoryI18nError", {
  message: Schema.String,
}) {}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (all, chunk) => all + chunk,
    ),
  );

const git = Effect.fn("factoryI18n.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collect(child.stdout), collect(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0) {
        return yield* new FactoryI18nError({ message: `git ${args.join(" ")}: ${stderr.trim()}` });
      }
      return stdout;
    }),
  );
});

const readCatalog = Effect.fn("factoryI18n.readCatalog")(function* (text: string, name: string) {
  return yield* decodeCatalog(text).pipe(
    Effect.mapError(() => new FactoryI18nError({ message: `Invalid catalog: ${name}` })),
  );
});

const run = Effect.fn("factoryI18n.run")(function* (
  mode: "merge" | "check",
  base: string,
  selected: ReadonlyArray<App>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = (yield* git(process.cwd(), ["rev-parse", "--show-toplevel"])).trim();
  const revision = (yield* git(root, ["merge-base", base, "HEAD"])).trim();
  let problems = 0;
  for (const app of selected) {
    const catalogDir = `apps/${app}/src/i18n/translations`;
    const overlayDir = path.join(root, "factory", "i18n", app);
    const upstreamEnText = yield* git(root, ["show", `${revision}:${catalogDir}/en.json`]);
    const upstreamEn = yield* readCatalog(upstreamEnText, `${app} upstream en`);
    const enText = yield* fs.readFileString(path.join(root, catalogDir, "en.json"));
    const en = yield* readCatalog(enText, `${app} en`);
    const keys = forkKeys(upstreamEn, en);
    const source = Object.fromEntries(
      Object.entries(en).filter(([key]) => !Object.hasOwn(upstreamEn, key)),
    );
    yield* Console.log(`${app}: ${keys.length} fork keys`);
    const sourcePath = path.join(overlayDir, "source.json");
    if (mode === "merge") {
      yield* fs.makeDirectory(overlayDir, { recursive: true });
      yield* fs.writeFileString(sourcePath, formatSource(source));
    } else {
      const actualSource = (yield* fs.exists(sourcePath))
        ? yield* readCatalog(yield* fs.readFileString(sourcePath), sourcePath)
        : {};
      if (
        Object.keys(actualSource).length !== keys.length ||
        keys.some((key) => !jsonEqual(actualSource[key], source[key]))
      ) {
        yield* Console.error(`${app}: source.json disagrees with fork English keys`);
        problems++;
      }
    }
    const locales = (yield* fs.readDirectory(path.join(root, catalogDir)))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const overlays = (yield* fs.exists(overlayDir)) ? yield* fs.readDirectory(overlayDir) : [];
    for (const name of overlays.filter(
      (name) => name.endsWith(".json") && name !== "source.json",
    )) {
      const overlayPath = path.join(overlayDir, name);
      const overlay = yield* readCatalog(yield* fs.readFileString(overlayPath), overlayPath);
      if (mode === "merge") {
        const pruned = pruneAdoptedOverlayKeys(overlay, upstreamEn);
        if (Object.keys(pruned).length !== Object.keys(overlay).length) {
          yield* fs.writeFileString(overlayPath, formatSource(pruned));
        }
      }
      for (const key of Object.keys(overlay)) {
        if (!Object.hasOwn(source, key)) {
          if (mode === "merge" && Object.hasOwn(upstreamEn, key)) continue;
          yield* Console.error(`${app}/${name}: overlay key ${key} is not a fork key`);
          if (mode === "check") problems++;
        } else if (mode === "check" && !sameTranslationSlots(source[key], overlay[key])) {
          yield* Console.error(
            `${app}/${name}: overlay key ${key} has different slots or placeholders`,
          );
          problems++;
        }
      }
    }
    for (const name of locales) {
      const locale = name.slice(0, -5);
      const relative = `${catalogDir}/${name}`;
      const upstreamText =
        locale === "en" ? upstreamEnText : yield* git(root, ["show", `${revision}:${relative}`]);
      const upstream =
        locale === "en"
          ? upstreamEn
          : yield* readCatalog(upstreamText, `${app} upstream ${locale}`);
      const currentText =
        locale === "en" ? enText : yield* fs.readFileString(path.join(root, relative));
      const current = locale === "en" ? en : yield* readCatalog(currentText, relative);
      const overlayPath = path.join(overlayDir, name);
      const overlay =
        locale !== "en" && (yield* fs.exists(overlayPath))
          ? yield* readCatalog(yield* fs.readFileString(overlayPath), overlayPath)
          : {};
      const missing = locale === "en" ? [] : missingTranslationKeys(keys, overlay);
      if (mode === "merge") {
        const dropped = Object.keys(upstream).filter((key) => !Object.hasOwn(current, key));
        if (dropped.length)
          yield* Console.error(
            `${relative}: warning: generated catalog dropped ${dropped.length} upstream keys`,
          );
        const entries: Record<string, Schema.Json> = {};
        for (const [key, english] of Object.entries(source)) {
          const translated = overlay[key];
          entries[key] = translated === undefined ? english : translated;
        }
        yield* fs.writeFileString(
          path.join(root, relative),
          mergeCatalogText(upstreamText, entries),
        );
        yield* Console.log(`${app}/${locale}: ${missing.length} untranslated`);
      } else {
        if (!checkCatalogText(upstreamText, currentText, keys)) {
          yield* Console.error(`${relative}: catalog is not upstream plus sorted fork keys`);
          problems++;
        }
        const absent = keys.filter((key) => !Object.hasOwn(current, key));
        if (absent.length) {
          yield* Console.error(
            `${relative}: missing ${absent.length} fork keys: ${absent.join(", ")}`,
          );
          problems++;
        }
        if (missing.length) {
          yield* Console.error(
            `${app}/${locale}: ${missing.length} untranslated: ${missing
              .slice(0, 5)
              .map((key) => `${key}=${displayValue(en[key])}`)
              .join("; ")}`,
          );
          problems++;
        }
        const mismatched = keys.filter(
          (key) => Object.hasOwn(overlay, key) && !jsonEqual(current[key], overlay[key]),
        );
        if (mismatched.length) {
          yield* Console.error(
            `${relative}: ${mismatched.length} translations differ from overlay: ${mismatched.slice(0, 5).join(", ")}`,
          );
          problems++;
        }
      }
    }
  }
  if (problems) process.exitCode = 1;
});

const command = Command.make("factory-i18n").pipe(
  Command.withSubcommands([
    Command.make(
      "merge",
      {
        base: Flag.String("base").pipe(Flag.withDefault("origin/main")),
        app: Flag.Literals("app", apps).pipe(Flag.atLeast(0)),
      },
      ({ base, app }) => run("merge", base, app.length ? [...new Set(app)] : apps),
    ),
    Command.make(
      "check",
      { base: Flag.String("base").pipe(Flag.withDefault("origin/main")) },
      ({ base }) => run("check", base, apps),
    ),
  ]),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Console.error(
          (error instanceof Error ? error.message : String(error)).replace(/\s*\r?\n\s*/g, " "),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      onSuccess: () => Effect.void,
    }),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
