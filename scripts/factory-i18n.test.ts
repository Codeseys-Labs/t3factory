import { assert, it } from "@effect/vitest";

import {
  checkCatalogText,
  forkKeys,
  jsonEqual,
  mergeCatalogText,
  missingTranslationKeys,
  pruneAdoptedOverlayKeys,
  sameTranslationSlots,
} from "./factory-i18n.ts";

it("identifies only generated keys absent upstream, in sorted order", () => {
  assert.deepStrictEqual(forkKeys({ old: "Old" }, { z: "Z", old: "Changed", a: "A" }), ["a", "z"]);
});

it("prunes keys adopted upstream while retaining other overlay entries", () => {
  assert.deepStrictEqual(
    pruneAdoptedOverlayKeys({ adopted: "A", fork: "F", stale: "S" }, { adopted: "A" }),
    { fork: "F", stale: "S" },
  );
});

it.each(["\n", ""])(
  "appends sorted keys while preserving upstream content with final newline %j",
  (ending) => {
    const upstream = `{\n  "old": "Original"\n}${ending}`;
    const entries = { z: 'Quote " slash \\', a: "日本語 {count}" };
    const merged = mergeCatalogText(upstream, entries);
    assert.isTrue(merged.startsWith('{\n  "old": "Original",\n'));
    assert.isTrue(merged.endsWith(`}${ending}`));
    assert.deepStrictEqual(JSON.parse(merged), { old: "Original", a: entries.a, z: entries.z });
    assert.deepStrictEqual(Object.keys(JSON.parse(merged)), ["old", "a", "z"]);
    assert.equal(mergeCatalogText(upstream, entries), merged);
    assert.isTrue(checkCatalogText(upstream, merged, ["a", "z"]));
  },
);

it("keeps upstream text exactly when there are no fork keys", () => {
  const upstream = '{\r\n  "old": "Original"\r\n}\r\n';
  assert.equal(mergeCatalogText(upstream, {}), upstream);
  assert.isTrue(checkCatalogText(upstream, upstream, []));
});

it("appends entries to an empty catalog", () => {
  const merged = mergeCatalogText("{}\n", { a: "A" });
  assert.deepStrictEqual(JSON.parse(merged), { a: "A" });
  assert.equal(merged, '{\n  "a": "A"\n}\n');
});

it("rejects reordered upstream entries, missing fork keys, and an unsorted fork tail", () => {
  const upstream = '{\n  "first": "1",\n  "second": "2"\n}\n';
  const reordered = '{\n  "second": "2",\n  "first": "1",\n  "a": "A",\n  "z": "Z"\n}\n';
  const missing = '{\n  "first": "1",\n  "second": "2",\n  "a": "A"\n}\n';
  const unsorted = '{\n  "first": "1",\n  "second": "2",\n  "z": "Z",\n  "a": "A"\n}\n';
  assert.isFalse(checkCatalogText(upstream, reordered, ["a", "z"]));
  assert.isFalse(checkCatalogText(upstream, missing, ["a", "z"]));
  assert.isFalse(checkCatalogText(upstream, unsorted, ["a", "z"]));
});

it("formats mixed string and JSX array entries like the upstream catalogs", () => {
  const upstream = '{\n  "old": "Original"\n}\n';
  const jsx = [
    "Clone ",
    { i: 1, k: "_gt_value_1", v: "v" },
    " and bring the local files git does not track.",
  ];
  const entries = { z: "Plain text", a679fa27ddfabfd5: jsx };
  const merged = mergeCatalogText(upstream, entries);
  assert.equal(
    merged,
    `{
  "old": "Original",
  "a679fa27ddfabfd5": [
    "Clone ",
    {
      "i": 1,
      "k": "_gt_value_1",
      "v": "v"
    },
    " and bring the local files git does not track."
  ],
  "z": "Plain text"
}
`,
  );
  assert.deepStrictEqual(JSON.parse(merged), { old: "Original", ...entries });
  assert.isTrue(checkCatalogText(upstream, merged, ["a679fa27ddfabfd5", "z"]));
});

const valueSlot = { i: 1, k: "_gt_value_1", v: "v" };
const span = { t: "span", i: 1, c: { i: 2, k: "_gt_value_2", v: "v" } };
const link = { t: "Link", i: 1, c: "Settings → Labs" };

it.each([
  {
    name: "reordered clone",
    english: ["Clone ", valueSlot, " files"],
    translation: [valueSlot, " をクローン"],
    expected: true,
  },
  {
    name: "reordered nested span",
    english: ["New thread in", " ", span],
    translation: [span, " で新しいスレッド"],
    expected: true,
  },
  {
    name: "translated link child",
    english: ["Open ", link, " now"],
    translation: { t: "Link", i: 1, c: "設定 → Labs" },
    expected: true,
  },
  {
    name: "dropped slot",
    english: ["Clone ", valueSlot],
    translation: ["クローン"],
    expected: false,
  },
  {
    name: "changed element type",
    english: ["Open ", link],
    translation: [{ t: "Button", i: 1, c: "設定" }],
    expected: false,
  },
  {
    name: "changed element index",
    english: ["Open ", link],
    translation: [{ t: "Link", i: 2, c: "設定" }],
    expected: false,
  },
  {
    name: "duplicate slot",
    english: ["Clone ", valueSlot],
    translation: [valueSlot, valueSlot],
    expected: false,
  },
  {
    name: "dropped placeholder",
    english: "{count} files",
    translation: "ファイル",
    expected: false,
  },
  {
    name: "plural categories",
    english: "{count, plural, one {# file} other {# files}}",
    translation: "{count, plural, other {# ファイル}}",
    expected: true,
  },
  { name: "string to array", english: "text", translation: ["texte"], expected: false },
])("$name", ({ english, translation, expected }) => {
  assert.equal(sameTranslationSlots(english, translation), expected);
});

const variable = { i: 3, k: "_gt_value_3", v: "v" };
const one = { t: "C2", i: 2, c: [variable, " open blocker"] };
const other = { t: "C2", i: 2, c: [variable, " open blockers"] };
const japanese = { t: "C2", i: 2, c: [variable, " 件の未解決のブロッカー"] };
const plural = { t: "Plural", i: 1, d: { b: { one, other }, t: "p" } };
const branch = { t: "Branch", i: 1, d: { b: { active: one, done: other }, t: "b" } };

it.each([
  {
    name: "Japanese branches",
    english: plural,
    translation: { t: "Plural", i: 1, d: { b: { one: japanese, other: japanese }, t: "p" } },
    expected: true,
  },
  {
    name: "only other",
    english: plural,
    translation: { t: "Plural", i: 1, d: { b: { other: japanese }, t: "p" } },
    expected: true,
  },
  {
    name: "extra plural categories",
    english: plural,
    translation: {
      t: "Plural",
      i: 1,
      d: { b: { one: japanese, few: japanese, many: japanese, other: japanese }, t: "p" },
    },
    expected: true,
  },
  {
    name: "missing variable in a branch",
    english: plural,
    translation: {
      t: "Plural",
      i: 1,
      d: { b: { other: { t: "C2", i: 2, c: "ブロッカー" } }, t: "p" },
    },
    expected: false,
  },
  {
    name: "renamed application branch",
    english: branch,
    translation: { t: "Branch", i: 1, d: { b: { active: japanese, finished: japanese }, t: "b" } },
    expected: false,
  },
  {
    name: "changed branch type",
    english: plural,
    translation: { t: "Plural", i: 1, d: { b: { other: japanese }, t: "b" } },
    expected: false,
  },
  {
    name: "empty branches",
    english: plural,
    translation: { t: "Plural", i: 1, d: { b: {}, t: "p" } },
    expected: false,
  },
])("$name", ({ english, translation, expected }) => {
  assert.equal(sameTranslationSlots(english, translation), expected);
});

it("compares JSON objects independently of key order", () => {
  assert.isTrue(jsonEqual({ i: 1, k: "value" }, { k: "value", i: 1 }));
});

it("counts only keys absent from the overlay as untranslated", () => {
  assert.deepStrictEqual(
    missingTranslationKeys(["description"], { description: "Description" }),
    [],
  );
  assert.deepStrictEqual(missingTranslationKeys(["description"], {}), ["description"]);
});
