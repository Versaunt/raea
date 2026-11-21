// Writes cases.json: JS expressions and what Node's ICU (the V8 and ICU Chrome has) answers for each, for intl.rs to
// check engine/native/src/intl.js against on QuickJS. Run with TZ=UTC: node engine/native/tests/intl/gen.mjs
import { writeFileSync } from "node:fs";

if (new Date(0).getTimezoneOffset() !== 0) throw new Error("run with TZ=UTC");
const cases = [];
const add = (code) => {
  let out;
  try {
    out = JSON.stringify((0, eval)(code));
  } catch (e) {
    out = "throws " + e.constructor.name;
  }
  cases.push([code, out]);
};
const J = JSON.stringify;

// ---- numbers -----------------------------------------------------------------------------------------------------
const nums = [0, -0, 1, -1, 0.5, 1.005, 2.5, -2.5, 3.14159, 12.345, 999.995, 1234.5, 1234567.891, -1234567.891, 0.000123, 1e-7, 999999, 1e21, 123456789012345680000, 0.1 + 0.2, 1.45, 1.55, 15, 999, 1000, 9999.5, 99999, 123456, 1500000, 2.5e9, 7.8e12, 4.2e15, NaN, Infinity, -Infinity, 42, 0.07, 0.125, 19.99, 100];
const numOpts = [
  undefined, {}, { maximumFractionDigits: 0 }, { maximumFractionDigits: 2 }, { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  { minimumFractionDigits: 1 }, { minimumFractionDigits: 0, maximumFractionDigits: 1 }, { maximumSignificantDigits: 3 },
  { minimumSignificantDigits: 3 }, { minimumIntegerDigits: 3 }, { useGrouping: false }, { style: "percent" },
  { style: "percent", maximumFractionDigits: 1 }, { style: "currency", currency: "USD" }, { style: "currency", currency: "EUR" },
  { style: "currency", currency: "GBP" }, { style: "currency", currency: "JPY" }, { style: "currency", currency: "USD", currencyDisplay: "code" },
  { style: "currency", currency: "USD", currencyDisplay: "name" }, { style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol" },
  { style: "currency", currency: "USD", currencySign: "accounting" }, { style: "currency", currency: "USD", maximumFractionDigits: 0 },
  { style: "currency", currency: "CHF" }, { notation: "compact" }, { notation: "compact", compactDisplay: "long" },
  { notation: "compact", maximumFractionDigits: 1 }, { notation: "compact", style: "currency", currency: "USD" },
  { notation: "scientific" }, { notation: "engineering" }, { signDisplay: "always" }, { signDisplay: "exceptZero" },
  { signDisplay: "never" }, { signDisplay: "negative" }, { maximumFractionDigits: 0, roundingMode: "halfEven" },
  { maximumFractionDigits: 1, roundingMode: "floor" }, { maximumFractionDigits: 1, roundingMode: "ceil" },
  { maximumFractionDigits: 1, roundingMode: "trunc" }, { maximumFractionDigits: 2, roundingIncrement: 5, minimumFractionDigits: 2 },
  { minimumFractionDigits: 2, trailingZeroDisplay: "stripIfInteger" }, { maximumFractionDigits: 2, maximumSignificantDigits: 2, roundingPriority: "lessPrecision" },
  { maximumFractionDigits: 2, maximumSignificantDigits: 2, roundingPriority: "morePrecision" },
  { notation: "compact", useGrouping: "always" }, { useGrouping: "min2" },
];
for (const o of numOpts) for (const n of nums) {
  const ns = Object.is(n, -0) ? "-0" : String(n);
  add(`new Intl.NumberFormat("en-US"${o === undefined ? "" : ", " + J(o)}).format(${ns})`);
}
for (const o of numOpts) add(`new Intl.NumberFormat("en-US"${o === undefined ? "" : ", " + J(o)}).resolvedOptions()`);
for (const o of numOpts.slice(0, 30)) for (const n of [-1234.5, 0.5, 1e6, NaN]) add(`new Intl.NumberFormat("en-US"${o === undefined ? "" : ", " + J(o)}).formatToParts(${n})`);
// the lab's own calls
for (const n of [0, 3.14, 1234.5, 61234.567, 1e6, -42.1, 199, 0.005, 2.675])
  for (const dec of [0, 1, 2, 3]) add(`(${n}).toLocaleString("en-US", { minimumFractionDigits: ${dec}, maximumFractionDigits: ${dec} })`);
for (const n of [0, 7, 60, 1234, 61234, 1234567.891, -98765.4321, 0.1 + 0.2]) {
  add(`(${n}).toLocaleString()`);
  add(`(${n}).toLocaleString("en-US")`);
  add(`(${n}).toLocaleString("en-GB")`);
  add(`(${n}).toLocaleString("en")`);
  add(`(${n}).toLocaleString("en-US", { maximumFractionDigits: 0 })`);
}
add(`(12345678901234567890n).toLocaleString("en-US")`);
add(`(-5n).toLocaleString("en-US", { style: "currency", currency: "USD" })`);
add(`new Intl.NumberFormat("en-US").format("1234.5678")`);
add(`new Intl.NumberFormat("en-US", { maximumFractionDigits: 20 }).format("0.1000000000000000055511151231257827")`);
for (const c of ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "INR", "KRW", "CNY", "MXN", "BRL", "SEK", "KWD", "XYZ"])
  for (const d of ["symbol", "narrowSymbol", "code", "name"]) {
    add(`new Intl.NumberFormat("en-US", { style: "currency", currency: "${c}", currencyDisplay: "${d}" }).format(-1234.5)`);
    add(`new Intl.NumberFormat("en-US", { style: "currency", currency: "${c}", currencyDisplay: "${d}" }).format(1)`);
  }
add(`new Intl.NumberFormat("en-GB", { style: "currency", currency: "USD" }).format(5)`);
add(`new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(1234.5)`);
for (const m of ["ceil", "floor", "expand", "trunc", "halfCeil", "halfFloor", "halfExpand", "halfTrunc", "halfEven"])
  for (const n of [1.25, -1.25, 1.35, -1.35, 1.2501, 0.05]) add(`new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, roundingMode: "${m}" }).format(${n})`);
// errors
add(`new Intl.NumberFormat("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 1 })`);
add(`new Intl.NumberFormat("en-US", { style: "currency" })`);
add(`new Intl.NumberFormat("en-US", { style: "bogus" })`);
add(`new Intl.NumberFormat("not a locale!")`);

add(`Intl.getCanonicalLocales(["EN-us", "en-gb"])`);

// ---- dates -------------------------------------------------------------------------------------------------------
const dates = [Date.UTC(2026, 0, 5, 3, 14, 7, 123), Date.UTC(2025, 11, 31, 23, 59, 59, 999), Date.UTC(2026, 6, 4, 12, 0, 0), Date.UTC(2024, 1, 29, 0, 5, 9), Date.UTC(1999, 8, 9, 18, 30, 0), Date.UTC(2026, 2, 15, 20, 45, 0)];
const dateOpts = [
  {}, { dateStyle: "full" }, { dateStyle: "long" }, { dateStyle: "medium" }, { dateStyle: "short" }, { timeStyle: "full" },
  { timeStyle: "long" }, { timeStyle: "medium" }, { timeStyle: "short" }, { dateStyle: "full", timeStyle: "short" },
  { dateStyle: "long", timeStyle: "medium" }, { dateStyle: "medium", timeStyle: "short" }, { dateStyle: "short", timeStyle: "short" },
  { timeStyle: "short", hour12: false }, { dateStyle: "medium", timeStyle: "medium", hourCycle: "h23" },
  { hour: "numeric", minute: "2-digit" }, { hour: "numeric", minute: "2-digit", hour12: false }, { hour: "2-digit", minute: "2-digit" },
  { hour: "2-digit", minute: "2-digit", hour12: false }, { hour: "numeric" }, { hour: "numeric", minute: "numeric", second: "numeric" },
  { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: false }, { minute: "2-digit", second: "2-digit" },
  { month: "short", day: "numeric" }, { month: "long", day: "numeric" }, { month: "short", day: "numeric", year: "numeric" },
  { month: "long", day: "numeric", year: "numeric" }, { month: "2-digit", day: "2-digit", year: "numeric" },
  { month: "2-digit", day: "2-digit", year: "2-digit" }, { month: "numeric", day: "numeric" }, { month: "long", year: "numeric" },
  { month: "short", year: "numeric" }, { month: "numeric", year: "numeric" }, { weekday: "long" }, { weekday: "short" }, { weekday: "narrow" },
  { month: "long" }, { month: "short" }, { month: "narrow" }, { year: "numeric" }, { year: "2-digit" }, { day: "numeric" }, { day: "2-digit" },
  { weekday: "long", month: "long", day: "numeric" }, { weekday: "short", month: "short", day: "numeric" },
  { weekday: "long", year: "numeric", month: "long", day: "numeric" }, { weekday: "short", year: "numeric", month: "short", day: "numeric" },
  { weekday: "short", month: "numeric", day: "numeric" }, { weekday: "long", hour: "numeric", minute: "2-digit" },
  { weekday: "short", hour: "numeric" }, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" },
  { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" },
  { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
  { hour: "numeric", hourCycle: "h23" }, { hour: "numeric", minute: "2-digit", hourCycle: "h11" }, { hour: "numeric", minute: "2-digit", hourCycle: "h24" },
  { hour: "numeric", minute: "2-digit", timeZoneName: "short" }, { timeZoneName: "short" }, { timeZoneName: "long" },
  { hour: "numeric", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }, { second: "numeric", fractionalSecondDigits: 2 },
  { hour: "numeric", dayPeriod: "long" }, { hour: "numeric", minute: "2-digit", dayPeriod: "short" }, { era: "short", year: "numeric" },
  { era: "long", year: "numeric", month: "long", day: "numeric" }, { minute: "2-digit" }, { second: "2-digit" }, { minute: "numeric" },
];
for (const o of dateOpts) for (const t of dates) add(`new Intl.DateTimeFormat("en-US", ${J({ ...o, timeZone: "UTC" })}).format(${t})`);
for (const o of dateOpts) add(`new Intl.DateTimeFormat("en-US", ${J({ ...o, timeZone: "UTC" })}).resolvedOptions()`);
for (const o of dateOpts.slice(0, 25)) add(`new Intl.DateTimeFormat("en-US", ${J({ ...o, timeZone: "UTC" })}).formatToParts(${dates[0]})`);
for (const o of [{}, { dateStyle: "full" }, { dateStyle: "long" }, { dateStyle: "medium" }, { dateStyle: "short" }, { timeStyle: "short" }, { dateStyle: "long", timeStyle: "short" }, { hour: "numeric", minute: "2-digit" }, { hour: "numeric", minute: "2-digit", hour12: true }, { month: "short", day: "numeric" }, { weekday: "long", month: "long", day: "numeric" }, { month: "2-digit", day: "2-digit", year: "numeric" }])
  for (const t of dates.slice(0, 3)) add(`new Intl.DateTimeFormat("en-GB", ${J({ ...o, timeZone: "UTC" })}).format(${t})`);
for (const tz of ["UTC", "Etc/UTC", "GMT", "+05:30", "-08:00"]) {
  add(`new Intl.DateTimeFormat("en-US", { timeZone: "${tz}", dateStyle: "medium", timeStyle: "long" }).format(${dates[0]})`);
  add(`new Intl.DateTimeFormat("en-US", { timeZone: "${tz}", hour: "numeric", timeZoneName: "long" }).format(${dates[0]})`);
  add(`new Intl.DateTimeFormat("en-US", { timeZone: "${tz}" }).resolvedOptions().timeZone`);
}
// the host's own zone (this file runs with TZ=UTC; intl.rs runs these only where the host is on UTC too)
for (const t of dates) {
  const d = `new Date(${t})`;
  add(`${d}.toLocaleString()`);
  add(`${d}.toLocaleDateString()`);
  add(`${d}.toLocaleTimeString()`);
  add(`${d}.toLocaleString("en-US")`);
  add(`${d}.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })`);
  add(`${d}.toLocaleDateString("en-US", { weekday: "long" })`);
  add(`${d}.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })`);
  add(`${d}.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })`);
  add(`${d}.toLocaleDateString("en-US", { hour: "numeric" })`);
  add(`${d}.toLocaleTimeString("en-US", { month: "short" })`);
  add(`${d}.toLocaleString("en-GB")`);
}
add(`new Date(NaN).toLocaleString()`);
add(`new Intl.DateTimeFormat("en-US").format(NaN)`);
add(`new Intl.DateTimeFormat("en-US", { dateStyle: "short", hour: "numeric" })`);
add(`new Date(0).toLocaleDateString("en-US", { timeStyle: "short" })`);
add(`new Intl.DateTimeFormat().resolvedOptions()`);

// ---- plural, relative time, lists --------------------------------------------------------------------------------
for (const n of [0, 1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 1.5, -1, 1000])
  for (const o of [{}, { type: "ordinal" }, { minimumFractionDigits: 1 }]) add(`new Intl.PluralRules("en-US", ${J(o)}).select(${n})`);
add(`new Intl.PluralRules("en-US").resolvedOptions()`);
add(`new Intl.PluralRules("en-US", { type: "ordinal" }).resolvedOptions()`);
for (const st of ["long", "short", "narrow"])
  for (const nu of ["always", "auto"])
    for (const u of ["second", "minute", "hour", "day", "week", "month", "quarter", "year", "days"])
      for (const v of [-2, -1, 0, 1, 2, 1000, -0, 1.5]) add(`new Intl.RelativeTimeFormat("en", { style: "${st}", numeric: "${nu}" }).format(${Object.is(v, -0) ? "-0" : v}, "${u}")`);
add(`new Intl.RelativeTimeFormat("en").formatToParts(-1234, "day")`);
add(`new Intl.RelativeTimeFormat("en", { numeric: "auto" }).formatToParts(1, "day")`);
add(`new Intl.RelativeTimeFormat("en-US").resolvedOptions()`);
for (const t of ["conjunction", "disjunction", "unit"])
  for (const st of ["long", "short", "narrow"])
    for (const l of [[], ["A"], ["A", "B"], ["A", "B", "C"], ["apples", "pears", "plums", "figs"]]) add(`new Intl.ListFormat("en", { type: "${t}", style: "${st}" }).format(${J(l)})`);
add(`new Intl.ListFormat("en-US").formatToParts(["a", "b", "c"])`);
add(`new Intl.ListFormat("en-US", { type: "disjunction" }).resolvedOptions()`);

// ---- collation ---------------------------------------------------------------------------------------------------
const words = ["apple", "Apple", "APPLE", "banana", "Banana", "b", "a", "A", "Z", "z", "item 2", "item 10", "item 1", "résumé", "resume", "Resume", "éclair", "eclair", "zebra", "_x", "-x", "x-ray", "x ray", "xray", "10", "9", "2", "a1", "a10", "a2", "file.txt", "file-2.txt", "File.TXT", "", " ", "abc", "ab"];
for (const o of [undefined, { numeric: true }, { sensitivity: "base" }, { sensitivity: "accent" }, { sensitivity: "case" }, { caseFirst: "upper" }])
  add(`${J(words)}.slice().sort(new Intl.Collator("en"${o ? ", " + J(o) : ""}).compare)`);
for (const [a, b] of [["a", "b"], ["a", "A"], ["A", "a"], ["résumé", "resume"], ["a", "a"], ["10", "9"], ["item 10", "item 9"]]) {
  add(`${J(a)}.localeCompare(${J(b)})`);
  add(`${J(a)}.localeCompare(${J(b)}, undefined, { numeric: true })`);
  add(`${J(a)}.localeCompare(${J(b)}, "en", { sensitivity: "base" })`);
}
add(`new Intl.Collator("en-US").resolvedOptions()`);

// ---- other built-ins ---------------------------------------------------------------------------------------------
add(`[1234.5, new Date(${dates[0]}), "x", null, 7].toLocaleString("en-US", { timeZone: "UTC" })`);
add(`[1234567, 0.5].toLocaleString()`);
add(`"istanbul".toLocaleUpperCase("en-US")`);
add(`"ÄBC".toLocaleLowerCase()`);


// ---- what raea answers on its own: other locales throw rather than come out in English ----------------------------
for (const code of [`(5).toLocaleString("de-DE")`, `new Intl.NumberFormat("fr")`, `new Intl.DateTimeFormat("ja-JP")`, `new Date(0).toLocaleDateString("es")`, `"a".localeCompare("b", "sv")`, `new Intl.PluralRules("ar")`, `new Intl.NumberFormat(["en-CA"])`])
  cases.push([code, "throws RangeError"]);
cases.push([`Intl.NumberFormat.supportedLocalesOf(["en-US", "de-DE", "en-GB", "fr"])`, '["en-US","en-GB"]']);
cases.push([`new Intl.NumberFormat(["de-DE", "en-US"]).resolvedOptions().locale`, '"en-US"']);
writeFileSync(new URL("./cases.json", import.meta.url), JSON.stringify(cases, null, 0).replace(/\],\[/g, "],\n["));
console.log(cases.length + " cases");
