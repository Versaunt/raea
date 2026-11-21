// A portable Intl for engines without one (QuickJS has no Intl): English only (en, en-US, en-GB), with output as
// Chrome's ICU gives it for the options here. host::install runs it on any engine that lacks Intl, never on
// JavaScriptCore, which has the real one. Another locale throws a RangeError rather than coming out in English;
// supportedLocalesOf answers honestly. Tested against Node's ICU: engine/native/tests/intl.rs.
//   NumberFormat   decimal, percent, currency (symbol, narrowSymbol, code, name; accounting), compact short and long,
//                  scientific and engineering, grouping, fraction and significant digits, rounding modes, priority and
//                  increment, signDisplay, format, formatToParts, resolvedOptions
//   DateTimeFormat dateStyle and timeStyle, the component options, hour12 and hourCycle, timeZone UTC, fixed offsets
//                  and the host's own zone, format, formatToParts, resolvedOptions
//   PluralRules, RelativeTimeFormat, ListFormat, Collator (ICU's order for ASCII, accents folded, numeric)
// and the locale-aware built-ins (Number, BigInt, Date, Array, String) through them. Intl.Segmenter is left out.
(function (g) {
"use strict";
if (typeof g.Intl !== "undefined") return;

// ---- locales -----------------------------------------------------------------------------------------------------
const ENGLISH = { en: "en", "en-us": "en-US", "en-gb": "en-GB" };
const TAG = /^[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?(-([a-z\d]{5,8}|\d[a-z\d]{3}))*(-[a-wy-z\d](-[a-z\d]{2,8})+)*(-x(-[a-z\d]{1,8})+)?$/i;
const localeList = (locales) => {
  if (locales === undefined) return [];
  const list = typeof locales === "string" ? [locales] : Array.from(Object(locales));
  return list.map((t) => {
    if (typeof t !== "string" && (t === null || typeof t !== "object")) throw new TypeError("Language ID should be string or object.");
    t = String(t);
    if (!TAG.test(t)) throw new RangeError("Incorrect locale information provided");
    return t.split("-").map((p, i) => (i === 0 ? p.toLowerCase() : p.length === 2 ? p.toUpperCase() : p.length === 4 && /^[a-z]+$/i.test(p) ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p.toLowerCase())).join("-");
  });
};
// the English locale a tag names ("en-US-u-nu-latn": en-US), or undefined
const english = (t) => ENGLISH[t.toLowerCase().split(/-[a-wy-z\d]-/)[0].replace(/-latn\b/, "")];
// the locale a constructor resolves: the first English one asked for, en-US when none is asked; any other throws
const pick = (locales) => {
  const list = localeList(locales);
  if (!list.length) return "en-US";
  for (const t of list) if (english(t)) return english(t);
  throw new RangeError(`raea's portable Intl has English only (en, en-US, en-GB), not ${list.join(", ")}`);
};
const supportedLocalesOf = (locales) => localeList(locales).filter(english);

// ---- options -----------------------------------------------------------------------------------------------------
const toOptions = (o) => {
  if (o === undefined) return Object.create(null);
  if (o === null) throw new TypeError("Cannot convert undefined or null to object");
  return Object(o);
};
const getOpt = (o, k, allowed, def, who) => {
  let v = o[k];
  if (v === undefined) return def;
  if (allowed === Boolean) return !!v;
  v = String(v);
  if (allowed && !allowed.includes(v)) throw new RangeError(`Value ${v} out of range for ${who} options property ${k}`);
  return v;
};
const getNum = (o, k, min, max, def) => {
  let v = o[k];
  if (v === undefined) return def;
  v = Number(v);
  if (!(v >= min && v <= max)) throw new RangeError(`${k} value is out of range.`);
  return Math.floor(v);
};
const defNum = (v, min, max, def) => {
  if (v === undefined) return def;
  v = Number(v);
  if (!(v >= min && v <= max)) throw new RangeError("value is out of range.");
  return Math.floor(v);
};
const brand = (C, name) => {
  Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
  Object.defineProperty(C, "supportedLocalesOf", { value: function supportedLocalesOf_(l) { return supportedLocalesOf(l); }, writable: true, configurable: true });
};
// a method getter that answers one bound function per object, as format and compare are in the spec
const boundGetter = (C, name, fn) => Object.defineProperty(C.prototype, name, {
  get() {
    const k = "_" + name;
    if (!this[k]) Object.defineProperty(this, k, { value: fn.bind(this) });
    return this[k];
  },
  configurable: true,
});

// ---- exact decimals ------------------------------------------------------------------------------------------------
// a non-negative decimal: int(d) * 10^x, d with no leading or trailing zeros ("" is zero)
const norm = (d, x) => {
  d = d.replace(/^0+/, "");
  if (!d) return { d: "", x: 0 };
  const t = d.length - d.replace(/0+$/, "").length;
  return { d: d.slice(0, d.length - t), x: x + t };
};
// a finite number's shortest round-trip digits, which is what ICU formats
const decOf = (n) => {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(Math.abs(n)));
  return norm(m[1] + (m[2] || ""), +(m[3] || 0) - (m[2] || "").length);
};
const magOf = (v) => (v.d ? v.d.length + v.x : 1);
const P10 = (n) => 10n ** BigInt(n);
// v rounded to f fraction digits (f < 0: to tens, hundreds...) in steps of inc, under a rounding mode
const roundTo = (v, f, mode, inc, neg) => {
  if (!v.d || (inc === 1 && v.x >= -f)) return v;
  const sh = v.x + f;
  let q = BigInt(v.d), r = 0n, den = 1n;
  if (sh >= 0) q *= P10(sh);
  else { den = P10(-sh); r = q % den; q /= den; }
  if (inc !== 1) { const I = BigInt(inc); r += (q % I) * den; den *= I; q /= I; }
  let up = false;
  if (r !== 0n) {
    const c = r * 2n - den;
    up = mode === "ceil" ? !neg : mode === "floor" ? neg : mode === "expand" ? true : mode === "trunc" ? false
      : mode === "halfCeil" ? c > 0n || (c === 0n && !neg) : mode === "halfFloor" ? c > 0n || (c === 0n && neg)
      : mode === "halfTrunc" ? c > 0n : mode === "halfEven" ? c > 0n || (c === 0n && q % 2n === 1n) : c >= 0n;
  }
  if (up) q += 1n;
  if (inc !== 1) q *= BigInt(inc);
  return norm(q.toString(), -f);
};
// a numeric value: { nan } | { inf, neg } | { d, x, neg }
const valueOf = (x) => {
  if (typeof x === "bigint") return { neg: x < 0n, ...norm((x < 0n ? -x : x).toString(), 0) };
  if (typeof x === "string") {
    const s = x.trim();
    const m = /^([+-]?)(\d+\.?\d*|\.\d+)(?:e([+-]?\d+))?$/i.exec(s);
    if (m) {
      const [ip, fp = ""] = m[2].split(".");
      return { neg: m[1] === "-", ...norm(ip + fp, +(m[3] || 0) - fp.length) };
    }
    x = s === "" ? 0 : /^[+-]?Infinity$/.test(s) ? Number(s) : /^0[xob]/i.test(s) ? Number(s) : NaN;
  }
  x = Number(x);
  if (x !== x) return { nan: true, neg: false };
  const neg = x < 0 || Object.is(x, -0);
  if (!isFinite(x)) return { inf: true, neg };
  return { neg, ...decOf(x) };
};

// ---- NumberFormat --------------------------------------------------------------------------------------------------
// code: symbol | narrow | singular name | plural name | digits ("" where the same as the one before, or 2 digits)
const CURRENCIES = {};
"USD|$||US dollar|US dollars|;EUR|€||euro|euros|;GBP|£||British pound|British pounds|;JPY|¥||Japanese yen||0;CAD|CA$|$|Canadian dollar|Canadian dollars|;AUD|A$|$|Australian dollar|Australian dollars|;NZD|NZ$|$|New Zealand dollar|New Zealand dollars|;HKD|HK$|$|Hong Kong dollar|Hong Kong dollars|;SGD||$|Singapore dollar|Singapore dollars|;MXN|MX$|$|Mexican peso|Mexican pesos|;BRL|R$||Brazilian real|Brazilian reals|;CNY|CN¥|¥|Chinese yuan||;INR|₹||Indian rupee|Indian rupees|;KRW|₩||South Korean won||0;CHF|||Swiss franc|Swiss francs|;SEK||kr|Swedish krona|Swedish kronor|;NOK||kr|Norwegian krone|Norwegian kroner|;DKK||kr|Danish krone|Danish kroner|;PLN||zł|Polish zloty|Polish zlotys|;RUB||₽|Russian ruble|Russian rubles|;TRY||₺|Turkish lira|Turkish Lira|;ZAR||R|South African rand||;ILS|₪||Israeli new shekel|Israeli new shekels|;THB||฿|Thai baht||;PHP|₱||Philippine peso|Philippine pesos|;TWD|NT$|$|New Taiwan dollar|New Taiwan dollars|;IDR||Rp|Indonesian rupiah|Indonesian rupiahs|0;VND|₫||Vietnamese dong||0;AED|||UAE dirham|UAE dirhams|;SAR|||Saudi riyal|Saudi riyals|;CZK||Kč|Czech koruna|Czech korunas|;HUF||Ft|Hungarian forint|Hungarian forints|0;UAH||₴|Ukrainian hryvnia|Ukrainian hryvnias|;NGN||₦|Nigerian naira|Nigerian nairas|;EGP||E£|Egyptian pound|Egyptian pounds|;ARS||$|Argentine peso|Argentine pesos|;CLP||$|Chilean peso|Chilean pesos|0;COP||$|Colombian peso|Colombian pesos|0;KWD|||Kuwaiti dinar|Kuwaiti dinars|3;BHD|||Bahraini dinar|Bahraini dinars|3;XAF|FCFA||Central African CFA franc|Central African CFA francs|0;XOF|F CFA||West African CFA franc|West African CFA francs|0"
  .split(";").forEach((row) => {
    const [c, sym, narrow, one, other, digits] = row.split("|");
    CURRENCIES[c] = { sym: sym || c, narrow: narrow || sym || c, one, other: other || one, digits: digits === "" ? 2 : +digits };
  });
const GB_SYMBOLS = { USD: "US$", JPY: "JP¥" };
const currencyOf = (c) => CURRENCIES[c] || { sym: c, narrow: c, one: c, other: c, digits: 2 };
const COMPACT = { 3: ["K", "thousand"], 6: ["M", "million"], 9: ["B", "billion"], 12: ["T", "trillion"] };
const INCREMENTS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
const MODES = ["ceil", "floor", "expand", "trunc", "halfCeil", "halfFloor", "halfExpand", "halfTrunc", "halfEven"];
const NF = "Intl.NumberFormat";

function NumberFormat(locales, options) {
  if (!new.target) return new NumberFormat(locales, options);
  const o = toOptions(options);
  const s = (this._s = { locale: pick(locales), numberingSystem: "latn" });
  getOpt(o, "localeMatcher", ["lookup", "best fit"], "best fit", NF);
  const nu = getOpt(o, "numberingSystem", null, undefined, NF);
  if (nu !== undefined && nu !== "latn") throw new RangeError(`raea's portable Intl has only the latn numbering system, not ${nu}`);
  s.style = getOpt(o, "style", ["decimal", "percent", "currency", "unit"], "decimal", NF);
  if (s.style === "unit") throw new RangeError("raea's portable Intl.NumberFormat has no unit style");
  let currency = getOpt(o, "currency", null, undefined, NF);
  if (currency !== undefined && !/^[a-z]{3}$/i.test(currency)) throw new RangeError("Invalid currency code : " + currency);
  const currencyDisplay = getOpt(o, "currencyDisplay", ["code", "symbol", "narrowSymbol", "name"], "symbol", NF);
  const currencySign = getOpt(o, "currencySign", ["standard", "accounting"], "standard", NF);
  getOpt(o, "unit", null, undefined, NF);
  getOpt(o, "unitDisplay", ["short", "narrow", "long"], "short", NF);
  let mnfdDef = 0, mxfdDef = 3;
  if (s.style === "currency") {
    if (currency === undefined) throw new TypeError("Currency code is required with currency style.");
    s.currency = currency = currency.toUpperCase();
    s.currencyDisplay = currencyDisplay;
    s.currencySign = currencySign;
    mnfdDef = mxfdDef = currencyOf(currency).digits;
  } else if (s.style === "percent") mxfdDef = 0;
  s.notation = getOpt(o, "notation", ["standard", "scientific", "engineering", "compact"], "standard", NF);
  // SetNumberFormatDigitOptions
  s.minimumIntegerDigits = getNum(o, "minimumIntegerDigits", 1, 21, 1);
  let mnfd = o.minimumFractionDigits, mxfd = o.maximumFractionDigits, mnsd = o.minimumSignificantDigits, mxsd = o.maximumSignificantDigits;
  const inc = getNum(o, "roundingIncrement", 1, 5000, 1);
  if (!INCREMENTS.includes(inc)) throw new RangeError("roundingIncrement value is out of range.");
  const mode = getOpt(o, "roundingMode", MODES, "halfExpand", NF);
  const priority = getOpt(o, "roundingPriority", ["auto", "morePrecision", "lessPrecision"], "auto", NF);
  const tzd = getOpt(o, "trailingZeroDisplay", ["auto", "stripIfInteger"], "auto", NF);
  if (inc !== 1) mxfdDef = mnfdDef;
  const hasSd = mnsd !== undefined || mxsd !== undefined, hasFd = mnfd !== undefined || mxfd !== undefined;
  let needSd = true, needFd = true;
  if (priority === "auto") {
    needSd = hasSd;
    if (needSd || (!hasFd && s.notation === "compact")) needFd = false;
  }
  if (needSd) {
    if (hasSd) {
      mnsd = defNum(mnsd, 1, 21, 1);
      mxsd = defNum(mxsd, mnsd, 21, 21);
    } else { mnsd = 1; mxsd = 21; }
  }
  if (needFd) {
    if (hasFd) {
      mnfd = defNum(mnfd, 0, 100, undefined);
      mxfd = defNum(mxfd, 0, 100, undefined);
      if (mnfd === undefined) mnfd = Math.min(mnfdDef, mxfd);
      else if (mxfd === undefined) mxfd = Math.max(mxfdDef, mnfd);
      else if (mnfd > mxfd) throw new RangeError("maximumFractionDigits value is out of range.");
    } else { mnfd = mnfdDef; mxfd = mxfdDef; }
  }
  let rt;
  if (!needSd && !needFd) { mnfd = 0; mxfd = 0; mnsd = 1; mxsd = 2; rt = "morePrecision"; s._priority = "morePrecision"; }
  else if (priority === "auto") { rt = needSd ? "sd" : "fd"; s._priority = "auto"; }
  else { rt = priority; s._priority = priority; }
  if (inc !== 1) {
    if (rt !== "fd") throw new TypeError("roundingIncrement needs fraction digits rounding");
    if (mxfd !== mnfd) throw new RangeError("maximumFractionDigits must equal minimumFractionDigits with a roundingIncrement");
  }
  if (rt !== "sd") { s.minimumFractionDigits = mnfd; s.maximumFractionDigits = mxfd; }
  if (rt !== "fd") { s.minimumSignificantDigits = mnsd; s.maximumSignificantDigits = mxsd; }
  s._rt = rt;
  s.compactDisplay = getOpt(o, "compactDisplay", ["short", "long"], "short", NF);
  const groupDef = s.notation === "compact" ? "min2" : "auto";
  let ug = o.useGrouping;
  if (ug === undefined) ug = groupDef;
  else if (ug === true) ug = "always";
  else if (!ug) ug = false;
  else {
    ug = String(ug);
    if (ug === "true" || ug === "false") ug = groupDef;
    else if (!["min2", "auto", "always"].includes(ug)) throw new RangeError(`Value ${ug} out of range for ${NF} options property useGrouping`);
  }
  s.useGrouping = ug;
  s.signDisplay = getOpt(o, "signDisplay", ["auto", "never", "always", "exceptZero", "negative"], "auto", NF);
  s.roundingIncrement = inc;
  s.roundingMode = mode;
  s.trailingZeroDisplay = tzd;
}

// v rounded as the format's digit options say: [rounded, fraction digits to show at least]
const roundNumber = (s, v, neg) => {
  const m = magOf(v);
  const viaF = () => [roundTo(v, s.maximumFractionDigits, s.roundingMode, s.roundingIncrement, neg), s.minimumFractionDigits];
  const viaS = () => {
    const r = roundTo(v, s.maximumSignificantDigits - m, s.roundingMode, 1, neg);
    return [r, Math.max(0, s.minimumSignificantDigits - magOf(r))];
  };
  let res;
  if (s._rt === "sd") res = viaS();
  else if (s._rt === "fd") res = viaF();
  else {
    const sMore = s.maximumSignificantDigits - m >= s.maximumFractionDigits;
    res = (s._rt === "morePrecision" ? sMore : !sMore) ? viaS() : viaF();
  }
  if (s.trailingZeroDisplay === "stripIfInteger" && res[0].x >= 0) res[1] = 0;
  return res;
};
const shift = (v, k) => (v.d ? { d: v.d, x: v.x - k } : v);
// the parts of a formatted number for the format's settings s
const numberParts = (s, x) => {
  const v = valueOf(x);
  const out = [];
  const push = (type, value) => out.push({ type, value });
  let r = v, minF = 0, exp = null, compact = 0;
  if (!v.nan && !v.inf) {
    let w = s.style === "percent" ? shift(v, -2) : v;
    if (s.notation === "compact") {
      let k = magOf(w) <= 3 || !w.d ? 0 : Math.min(12, 3 * Math.floor((magOf(w) - 1) / 3));
      for (;;) {
        [r, minF] = roundNumber(s, shift(w, k), v.neg);
        if (r.d && magOf(r) > 3 && k < 12) { k += 3; continue; }
        break;
      }
      compact = k;
    } else if (s.notation === "scientific" || s.notation === "engineering") {
      const step = s.notation === "scientific" ? 1 : 3;
      let k = w.d ? step * Math.floor((magOf(w) - 1) / step) : 0;
      for (;;) {
        [r, minF] = roundNumber(s, shift(w, k), v.neg);
        if (r.d && magOf(r) > step) { k += step; continue; }
        break;
      }
      exp = k;
    } else [r, minF] = roundNumber(s, w, v.neg);
  }
  const zero = !v.nan && !v.inf && !r.d;
  const sd = s.signDisplay;
  let sign = v.nan ? (sd === "always" ? "+" : "") : sd === "never" ? "" : sd === "always" ? (v.neg ? "-" : "+") : sd === "exceptZero" ? (zero ? "" : v.neg ? "-" : "+") : sd === "negative" ? (v.neg && !zero ? "-" : "") : v.neg ? "-" : "";
  // the number's own digits
  let ip = "0", fp = "";
  const digits = [];
  if (v.nan) digits.push({ type: "nan", value: "NaN" });
  else if (v.inf) digits.push({ type: "infinity", value: "∞" });
  else {
    if (r.d) {
      if (r.x >= 0) ip = r.d + "0".repeat(r.x);
      else if (r.d.length > -r.x) { ip = r.d.slice(0, r.d.length + r.x); fp = r.d.slice(r.d.length + r.x); }
      else fp = "0".repeat(-r.x - r.d.length) + r.d;
    }
    fp = fp.padEnd(minF, "0");
    ip = ip.padStart(s.minimumIntegerDigits, "0");
    const group = s.useGrouping && ip.length >= (s.useGrouping === "min2" ? 5 : 4);
    if (group) {
      const first = ip.length % 3 || 3;
      digits.push({ type: "integer", value: ip.slice(0, first) });
      for (let i = first; i < ip.length; i += 3) digits.push({ type: "group", value: "," }, { type: "integer", value: ip.slice(i, i + 3) });
    } else digits.push({ type: "integer", value: ip });
    if (fp) digits.push({ type: "decimal", value: "." }, { type: "fraction", value: fp });
    if (exp !== null) {
      digits.push({ type: "exponentSeparator", value: "E" });
      if (exp < 0) digits.push({ type: "exponentMinusSign", value: "-" });
      digits.push({ type: "exponentInteger", value: String(Math.abs(exp)) });
    }
    if (compact) {
      if (s.compactDisplay === "long" && s.style !== "currency") digits.push({ type: "literal", value: " " }, { type: "compact", value: COMPACT[compact][1] });
      else digits.push({ type: "compact", value: COMPACT[compact][0] });
    }
  }
  const accounting = s.style === "currency" && s.currencySign === "accounting" && sign === "-";
  if (accounting) { push("literal", "("); sign = ""; }
  if (sign) push(sign === "-" ? "minusSign" : "plusSign", sign);
  if (s.style === "currency") {
    const c = currencyOf(s.currency);
    if (s.currencyDisplay === "name") {
      out.push(...digits);
      const one = !v.nan && !v.inf && ip === "1" && !fp && !compact && exp === null;
      push("literal", " ");
      push("currency", one ? c.one : c.other);
    } else {
      const sym = s.currencyDisplay === "code" ? s.currency : s.currencyDisplay === "narrowSymbol" ? c.narrow : (s.locale === "en-GB" && GB_SYMBOLS[s.currency]) || c.sym;
      push("currency", sym);
      if (/[A-Za-z]$/.test(sym) && !v.nan && !v.inf) push("literal", "\u00a0");
      out.push(...digits);
    }
  } else {
    out.push(...digits);
    if (s.style === "percent") push("percentSign", "%");
  }
  if (accounting) push("literal", ")");
  return out;
};
const joinParts = (parts) => parts.map((p) => p.value).join("");
const toNumeric = (x) => (typeof x === "bigint" || typeof x === "string" ? x : Number(x));
boundGetter(NumberFormat, "format", function (x) { return joinParts(numberParts(this._s, toNumeric(x))); });
Object.assign(NumberFormat.prototype, {
  formatToParts(x) { return numberParts(this._s, toNumeric(x)); },
  formatRange(a, b) {
    if (a === undefined || b === undefined) throw new TypeError("start or end is undefined");
    const x = this.format(a), y = this.format(b);
    return x === y ? "~" + x : x + "–" + y;
  },
  resolvedOptions() {
    const s = this._s, r = {};
    for (const k of ["locale", "numberingSystem", "style", "currency", "currencyDisplay", "currencySign", "minimumIntegerDigits", "minimumFractionDigits", "maximumFractionDigits", "minimumSignificantDigits", "maximumSignificantDigits", "useGrouping", "notation", "compactDisplay", "signDisplay", "roundingIncrement", "roundingMode", "roundingPriority", "trailingZeroDisplay"]) {
      if (k === "compactDisplay" && s.notation !== "compact") continue;
      // V8 reports "auto" whenever trailingZeroDisplay is stripIfInteger
      if (k === "roundingPriority") r[k] = s.trailingZeroDisplay === "stripIfInteger" ? "auto" : s._priority;
      else if (s[k] !== undefined) r[k] = s[k];
    }
    return r;
  },
});
brand(NumberFormat, NF);

// ---- PluralRules ---------------------------------------------------------------------------------------------------
function PluralRules(locales, options) {
  if (!new.target) throw new TypeError("Constructor Intl.PluralRules requires 'new'");
  const o = toOptions(options);
  const locale = pick(locales);
  const type = getOpt(o, "type", ["cardinal", "ordinal"], "cardinal", "Intl.PluralRules");
  const nfo = {};
  for (const k of ["minimumIntegerDigits", "minimumFractionDigits", "maximumFractionDigits", "minimumSignificantDigits", "maximumSignificantDigits", "roundingIncrement", "roundingMode", "roundingPriority", "trailingZeroDisplay"]) if (o[k] !== undefined) nfo[k] = o[k];
  this._s = { locale: locale && "en", type, nf: new NumberFormat("en", { ...nfo, useGrouping: false }) };
}
Object.assign(PluralRules.prototype, {
  select(n) {
    n = Number(n);
    if (!isFinite(n)) return "other";
    const str = this._s.nf.format(Math.abs(n));
    if (this._s.type === "ordinal") {
      if (str.includes(".")) return "other";
      const i = +str.slice(-2), t = i % 10;
      return t === 1 && i !== 11 ? "one" : t === 2 && i !== 12 ? "two" : t === 3 && i !== 13 ? "few" : "other";
    }
    return str === "1" ? "one" : "other";
  },
  selectRange(a, b) {
    if (a === undefined || b === undefined) throw new TypeError("start or end is undefined");
    return this.select(b);
  },
  resolvedOptions() {
    const s = this._s, n = s.nf.resolvedOptions(), r = { locale: s.locale, type: s.type };
    for (const k of ["minimumIntegerDigits", "minimumFractionDigits", "maximumFractionDigits", "minimumSignificantDigits", "maximumSignificantDigits"]) if (n[k] !== undefined) r[k] = n[k];
    r.pluralCategories = s.type === "ordinal" ? ["few", "one", "two", "other"] : ["one", "other"];
    r.roundingIncrement = n.roundingIncrement;
    r.roundingMode = n.roundingMode;
    r.roundingPriority = n.roundingPriority;
    r.trailingZeroDisplay = n.trailingZeroDisplay;
    return r;
  },
});
brand(PluralRules, "Intl.PluralRules");

// ---- RelativeTimeFormat --------------------------------------------------------------------------------------------
// per unit: in 1 | in n | 1 ago | n ago | auto -1 | auto 0 | auto +1 ("#" is the number; an auto form with "#" has no word)
const RTF = {
  long: "in # second|in # seconds|# second ago|# seconds ago|# second ago|now|in # second;in # minute|in # minutes|# minute ago|# minutes ago|# minute ago|this minute|in # minute;in # hour|in # hours|# hour ago|# hours ago|# hour ago|this hour|in # hour;in # day|in # days|# day ago|# days ago|yesterday|today|tomorrow;in # week|in # weeks|# week ago|# weeks ago|last week|this week|next week;in # month|in # months|# month ago|# months ago|last month|this month|next month;in # quarter|in # quarters|# quarter ago|# quarters ago|last quarter|this quarter|next quarter;in # year|in # years|# year ago|# years ago|last year|this year|next year",
  short: "in # sec.|in # sec.|# sec. ago|# sec. ago|# sec. ago|now|in # sec.;in # min.|in # min.|# min. ago|# min. ago|# min. ago|this minute|in # min.;in # hr.|in # hr.|# hr. ago|# hr. ago|# hr. ago|this hour|in # hr.;in # day|in # days|# day ago|# days ago|yesterday|today|tomorrow;in # wk.|in # wk.|# wk. ago|# wk. ago|last wk.|this wk.|next wk.;in # mo.|in # mo.|# mo. ago|# mo. ago|last mo.|this mo.|next mo.;in # qtr.|in # qtrs.|# qtr. ago|# qtrs. ago|last qtr.|this qtr.|next qtr.;in # yr.|in # yr.|# yr. ago|# yr. ago|last yr.|this yr.|next yr.",
  narrow: "in #s|in #s|#s ago|#s ago|#s ago|now|in #s;in #m|in #m|#m ago|#m ago|#m ago|this minute|in #m;in #h|in #h|#h ago|#h ago|#h ago|this hour|in #h;in #d|in #d|#d ago|#d ago|yesterday|today|tomorrow;in #w|in #w|#w ago|#w ago|last wk.|this wk.|next wk.;in #mo|in #mo|#mo ago|#mo ago|last mo.|this mo.|next mo.;in #q|in #q|#q ago|#q ago|last qtr.|this qtr.|next qtr.;in #y|in #y|#y ago|#y ago|last yr.|this yr.|next yr.",
};
const RTF_UNITS = ["second", "minute", "hour", "day", "week", "month", "quarter", "year"];
for (const k in RTF) RTF[k] = RTF[k].split(";").map((u) => u.split("|"));
function RelativeTimeFormat(locales, options) {
  if (!new.target) throw new TypeError("Constructor Intl.RelativeTimeFormat requires 'new'");
  const o = toOptions(options);
  const locale = pick(locales);
  getOpt(o, "localeMatcher", ["lookup", "best fit"], "best fit", "Intl.RelativeTimeFormat");
  const nu = getOpt(o, "numberingSystem", null, undefined, "Intl.RelativeTimeFormat");
  if (nu !== undefined && nu !== "latn") throw new RangeError(`raea's portable Intl has only the latn numbering system, not ${nu}`);
  this._s = {
    locale,
    style: getOpt(o, "style", ["long", "short", "narrow"], "long", "Intl.RelativeTimeFormat"),
    numeric: getOpt(o, "numeric", ["always", "auto"], "always", "Intl.RelativeTimeFormat"),
    nf: new NumberFormat("en"),
  };
}
const rtfParts = (s, value, unit) => {
  value = Number(value);
  if (!isFinite(value)) throw new RangeError("Invalid time value");
  unit = String(unit);
  const u = RTF_UNITS.indexOf(unit.replace(/s$/, ""));
  if (u < 0) throw new RangeError("Invalid unit argument for format() '" + unit + "'");
  const row = RTF[s.style][u];
  const neg = value < 0 || Object.is(value, -0);
  if (s.numeric === "auto" && (value === -1 || value === 0 || value === 1)) {
    const word = row[5 + value];
    if (!word.includes("#") && !(value === 0 && neg && u !== 0 && false)) return [{ type: "literal", value: word }];
  }
  const nparts = s.nf.formatToParts(Math.abs(value));
  const one = nparts.length === 1 && nparts[0].value === "1";
  const pattern = row[(neg ? 2 : 0) + (one ? 0 : 1)];
  const [pre, post] = pattern.split("#");
  const out = [];
  if (pre) out.push({ type: "literal", value: pre });
  for (const p of nparts) out.push({ ...p, unit: RTF_UNITS[u] });
  if (post) out.push({ type: "literal", value: post });
  return out;
};
Object.assign(RelativeTimeFormat.prototype, {
  format(value, unit) { return joinParts(rtfParts(this._s, value, unit)); },
  formatToParts(value, unit) { return rtfParts(this._s, value, unit); },
  resolvedOptions() { const s = this._s; return { locale: s.locale, style: s.style, numeric: s.numeric, numberingSystem: "latn" }; },
});
brand(RelativeTimeFormat, "Intl.RelativeTimeFormat");

// ---- ListFormat ----------------------------------------------------------------------------------------------------
// type-style: [between two, between the others, before the last of three or more]
const LISTS = {
  "conjunction-long": [" and ", ", ", ", and "], "conjunction-short": [" & ", ", ", ", & "], "conjunction-narrow": [", ", ", ", ", "],
  "disjunction-long": [" or ", ", ", ", or "], "disjunction-short": [" or ", ", ", ", or "], "disjunction-narrow": [" or ", ", ", ", or "],
  "unit-long": [", ", ", ", ", "], "unit-short": [", ", ", ", ", "], "unit-narrow": [" ", " ", " "],
};
function ListFormat(locales, options) {
  if (!new.target) throw new TypeError("Constructor Intl.ListFormat requires 'new'");
  const o = toOptions(options);
  const locale = pick(locales);
  getOpt(o, "localeMatcher", ["lookup", "best fit"], "best fit", "Intl.ListFormat");
  this._s = { locale, type: getOpt(o, "type", ["conjunction", "disjunction", "unit"], "conjunction", "Intl.ListFormat"), style: getOpt(o, "style", ["long", "short", "narrow"], "long", "Intl.ListFormat") };
}
const listParts = (s, list) => {
  const items = [];
  if (list !== undefined) for (const x of list) {
    if (typeof x !== "string") throw new TypeError("Iterable yielded " + String(x) + " which is not a string");
    items.push(x);
  }
  const [two, mid, last] = LISTS[s.type + "-" + s.style];
  const out = [];
  items.forEach((x, i) => {
    if (i > 0) out.push({ type: "literal", value: items.length === 2 ? two : i === items.length - 1 ? last : mid });
    out.push({ type: "element", value: x });
  });
  return out;
};
Object.assign(ListFormat.prototype, {
  format(list) { return joinParts(listParts(this._s, list)); },
  formatToParts(list) { return listParts(this._s, list); },
  resolvedOptions() { const s = this._s; return { locale: s.locale, type: s.type, style: s.style }; },
});
brand(ListFormat, "Intl.ListFormat");

// ---- Collator ------------------------------------------------------------------------------------------------------
// ICU's root order for printable ASCII (letters by case folded, lowercase first); other characters after, by code point
const ORDER = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ";
const PRIMARY = new Map(), TERTIARY = new Map();
for (let i = 0, w = 1; i < ORDER.length; i++) {
  const c = ORDER[i], letter = /[a-z]/i.test(c);
  if (letter && /[A-Z]/.test(c)) { PRIMARY.set(c, PRIMARY.get(c.toLowerCase())); TERTIARY.set(c, 1); }
  else { PRIMARY.set(c, w++); TERTIARY.set(c, 0); }
}
const PUNCT = /[\s_\-,;:!?.'"()[\]{}@*/\\&#%`^+<=>|~$]/;
// a string's collation elements: [primary, secondary (accents), tertiary (case)], digit runs as one number when numeric
const elements = (str, s) => {
  const out = [];
  const chars = [...String(str).normalize("NFD")];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/[\u0300-\u036f]/.test(c)) { if (out.length) out[out.length - 1][1] += c; continue; }
    if (s.ignorePunctuation && PUNCT.test(c)) continue;
    if (s.numeric && /\d/.test(c)) {
      let j = i;
      while (j < chars.length && /\d/.test(chars[j])) j++;
      const run = chars.slice(i, j).join("").replace(/^0+(?=\d)/, "");
      out.push([PRIMARY.get("0"), "", 0, run]);
      i = j - 1;
      continue;
    }
    const lower = c.toLowerCase();
    const p = PRIMARY.has(c) ? PRIMARY.get(c) : 1000 + (PRIMARY.has(lower) ? PRIMARY.get(lower) : lower.codePointAt(0));
    out.push([p, "", c !== lower ? 1 : TERTIARY.get(c) || 0]);
  }
  return out;
};
function Collator(locales, options) {
  if (!new.target) return new Collator(locales, options);
  const o = toOptions(options);
  const usage = getOpt(o, "usage", ["sort", "search"], "sort", "Intl.Collator");
  const locale = pick(locales);
  getOpt(o, "localeMatcher", ["lookup", "best fit"], "best fit", "Intl.Collator");
  getOpt(o, "collation", null, undefined, "Intl.Collator");
  const numeric = getOpt(o, "numeric", Boolean, false);
  const caseFirst = getOpt(o, "caseFirst", ["upper", "lower", "false"], "false", "Intl.Collator");
  const sensitivity = getOpt(o, "sensitivity", ["base", "accent", "case", "variant"], "variant", "Intl.Collator");
  const ignorePunctuation = getOpt(o, "ignorePunctuation", Boolean, false);
  this._s = { locale: locale === "en-GB" ? "en" : locale, usage, sensitivity, ignorePunctuation, collation: "default", numeric, caseFirst };
}
const collate = (s, a, b) => {
  const x = elements(a, s), y = elements(b, s);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i][0] !== y[i][0]) return x[i][0] < y[i][0] ? -1 : 1;
    if (x[i][3] !== undefined || y[i][3] !== undefined) {
      const p = x[i][3] || "", q = y[i][3] || "";
      if (p.length !== q.length) return p.length < q.length ? -1 : 1;
      if (p !== q) return p < q ? -1 : 1;
    }
  }
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  if (s.sensitivity === "accent" || s.sensitivity === "variant") for (let i = 0; i < n; i++) if (x[i][1] !== y[i][1]) return x[i][1] < y[i][1] ? -1 : 1;
  if (s.sensitivity === "case" || s.sensitivity === "variant") {
    const flip = s.caseFirst === "upper" ? -1 : 1;
    for (let i = 0; i < n; i++) if (x[i][2] !== y[i][2]) return (x[i][2] < y[i][2] ? -1 : 1) * flip;
  }
  if (s.sensitivity === "variant" && !s.ignorePunctuation) {
    const p = String(a).normalize("NFC"), q = String(b).normalize("NFC");
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
};
boundGetter(Collator, "compare", function (a, b) { return collate(this._s, String(a), String(b)); });
Collator.prototype.resolvedOptions = function () { return { ...this._s }; };
brand(Collator, "Intl.Collator");

// ---- DateTimeFormat ------------------------------------------------------------------------------------------------
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// the skeletons en has its own patterns for (CLDR availableFormats); a key's letters are the fields it covers
const SKELETONS = {
  "en-US": {
    d: "d", E: "ccc", Ed: "d E", Gy: "y G", GyMd: "M/d/y G", GyMMM: "MMM y G", GyMMMd: "MMM d, y G", GyMMMEd: "E, MMM d, y G",
    M: "L", Md: "M/d", MEd: "E, M/d", MMM: "LLL", MMMd: "MMM d", MMMEd: "E, MMM d", MMMMd: "MMMM d", y: "y", yM: "M/y",
    yMd: "M/d/y", yMEd: "E, M/d/y", yMMM: "MMM y", yMMMd: "MMM d, y", yMMMEd: "E, MMM d, y", yMMMM: "MMMM y",
    h: "h a", H: "HH", hm: "h:mm a", Hm: "HH:mm", hms: "h:mm:ss a", Hms: "HH:mm:ss", ms: "mm:ss",
    Eh: "E h a", EH: "E HH", Ehm: "E h:mm a", EHm: "E HH:mm", Ehms: "E h:mm:ss a", EHms: "E HH:mm:ss",
    Bh: "h B", Bhm: "h:mm B", Bhms: "h:mm:ss B", EBh: "E h B", EBhm: "E h:mm B", EBhms: "E h:mm:ss B",
  },
  "en-GB": {
    d: "d", E: "ccc", Ed: "E d", Gy: "y G", GyMd: "dd/MM/y G", GyMMM: "MMM y G", GyMMMd: "d MMM y G", GyMMMEd: "E, d MMM y G",
    M: "L", Md: "dd/MM", MEd: "E dd/MM", MMM: "LLL", MMMd: "d MMM", MMMEd: "E d MMM", MMMMd: "d MMMM", y: "y", yM: "MM/y",
    yMd: "dd/MM/y", yMEd: "E, dd/MM/y", yMMM: "MMM y", yMMMd: "d MMM y", yMMMEd: "E, d MMM y", yMMMM: "MMMM y",
    h: "h a", H: "HH", hm: "h:mm a", Hm: "HH:mm", hms: "h:mm:ss a", Hms: "HH:mm:ss", ms: "mm:ss",
    Eh: "E h a", EH: "E HH", Ehm: "E h:mm a", EHm: "E HH:mm", Ehms: "E h:mm:ss a", EHms: "E HH:mm:ss",
    Bh: "h B", Bhm: "h:mm B", Bhms: "h:mm:ss B", EBh: "E h B", EBhm: "E h:mm B", EBhms: "E h:mm:ss B",
  },
};
const STYLES = {
  "en-US": { date: { full: "EEEE, MMMM d, y", long: "MMMM d, y", medium: "MMM d, y", short: "M/d/yy" } },
  "en-GB": { date: { full: "EEEE, d MMMM y", long: "d MMMM y", medium: "d MMM y", short: "dd/MM/y" } },
};
const TIME_STYLES = { full: "h:mm:ss a zzzz", long: "h:mm:ss a z", medium: "h:mm:ss a", short: "h:mm a" };
// the field letters, in the order ICU ranks them
const FIELD_ORDER = "GyMEdBahHkKmsSz";
const fieldOf = (c) => (c === "L" ? "M" : c === "c" ? "E" : c === "H" || c === "k" || c === "K" ? "h" : c);
// a pattern's tokens: [letter run | literal text]
const tokens = (p) => {
  const out = [];
  for (let i = 0; i < p.length;) {
    const c = p[i];
    if (c === "'") {
      let j = i + 1, lit = "";
      while (j < p.length) {
        if (p[j] === "'") { if (p[j + 1] === "'") { lit += "'"; j += 2; continue; } break; }
        lit += p[j++];
      }
      out.push({ lit: lit || "'" });
      i = j + 1;
    } else if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (p[j] === c) j++;
      out.push({ f: c, n: j - i });
      i = j;
    } else {
      let j = i;
      while (j < p.length && p[j] !== "'" && !/[A-Za-z]/.test(p[j])) j++;
      out.push({ lit: p.slice(i, j) });
      i = j;
    }
  }
  return out;
};
const untokens = (t) => t.map((x) => (x.lit !== undefined ? (/[A-Za-z']/.test(x.lit) ? "'" + x.lit.replace(/'/g, "''") + "'" : x.lit) : x.f.repeat(x.n))).join("");
// a pattern for some fields of a request ({ field: letters }), as ICU's pattern generator gives it
const keyFields = (k) => new Set([...k.replace(/MMMM|MMM/, "M")].map(fieldOf));
const bestRaw = (table, req) => {
  const want = Object.keys(req);
  let best = null, bestN = 0, bestRank = 99;
  for (const k in table) {
    const fs = keyFields(k);
    if ([...fs].some((f) => !want.includes(f))) continue;
    // the month's kind must match: numeric (M) or text (MMM, MMMM)
    if (fs.has("M") && /MMM/.test(k) !== (req.M.length >= 3)) continue;
    if (fs.has("M") && req.M.length === 4 && /MMMM/.test(k) === false && table[k.replace("MMM", "MMMM")]) continue;
    if (fs.has("M") && req.M.length !== 4 && /MMMM/.test(k)) continue;
    if (fs.has("h") && /H/.test(k) !== /[Hk]/.test(req.h)) continue;
    if (fs.has("B") !== !!req.B && fs.has("h")) continue;
    if (fs.has("B") && !fs.has("h")) continue;
    const rank = Math.min(...[...fs].map((f) => FIELD_ORDER.indexOf(f)));
    if (fs.size > bestN || (fs.size === bestN && rank < bestRank)) { best = k; bestN = fs.size; bestRank = rank; }
  }
  return best;
};
// pattern widths set to the request's: text and numeric forms of month, day, year, weekday, era, hour. A numeric day
// and month keep the pattern's padding (en-GB's dd/MM) unless one of them asks for 2 digits with no weekday (ICU's way)
const adjust = (pattern, req) => { const exact = !req.E && (req.d === "dd" || req.M === "MM"); return untokens(tokens(pattern).map((t) => {
  if (t.lit !== undefined) return t;
  const f = fieldOf(t.f), r = req[f];
  if (!r) return t;
  if (f === "M" || f === "d") return { f: t.f, n: r.length <= 2 && t.n <= 2 && !exact ? Math.max(t.n, r.length) : r.length };
  if (f === "h") return { f: r[0], n: t.f === "H" || t.f === "k" ? Math.max(t.n, r.length) : r.length };
  if (f === "m" || f === "s") return { f: t.f, n: Math.max(t.n, r.length) };
  if (f === "E") return { f: t.f, n: r.length };
  if (f === "z") return { f: r[0], n: r.length };
  return { f: r[0], n: r.length };
})); };
const APPEND = { G: "{0} {1}", y: "{0} {1}", E: "{0} {1}", z: "{0} {1}", M: "{0} ({2}: {1})", d: "{0} ({2}: {1})", h: "{0} ({2}: {1})", m: "{0} ({2}: {1})", s: "{0} ({2}: {1})", B: "{0} {1}", a: "{0} {1}" };
const FIELD_NAMES = { M: "month", d: "day", h: "hour", m: "minute", s: "second" };
const bestAppending = (table, req) => {
  const k = bestRaw(table, req);
  let pattern, missing;
  if (k) {
    pattern = adjust(table[k], req);
    const fs = keyFields(k);
    missing = Object.keys(req).filter((f) => !fs.has(f));
  } else {
    const first = Object.keys(req).sort((a, b) => FIELD_ORDER.indexOf(a) - FIELD_ORDER.indexOf(b))[0];
    pattern = first === "m" || first === "s" ? first : req[first];
    missing = Object.keys(req).filter((f) => f !== first);
  }
  if (!missing.length) return pattern;
  const rest = {};
  for (const f of missing) rest[f] = req[f];
  const top = missing.sort((a, b) => FIELD_ORDER.indexOf(b) - FIELD_ORDER.indexOf(a))[0];
  return APPEND[top].replace("{0}", pattern).replace("{1}", bestAppending(table, rest)).replace("{2}", "'" + FIELD_NAMES[top] + "'");
};
const patternFor = (locale, req) => {
  const table = SKELETONS[locale];
  const k = bestRaw(table, req);
  if (k && keyFields(k).size === Object.keys(req).length) return adjust(table[k], req);
  const date = {}, time = {};
  for (const f in req) ("GyMEd".includes(f) ? date : time)[f] = req[f];
  const dp = Object.keys(date).length ? bestAppending(table, date) : "";
  const tp = Object.keys(time).length ? bestAppending(table, time) : "";
  if (!dp || !tp) return dp || tp;
  return dp + (date.M && date.M.length === 4 ? " 'at' " : ", ") + tp;
};

const WIDTHS = { numeric: 1, "2-digit": 2, short: 3, long: 4, narrow: 5 };
const DTF = "Intl.DateTimeFormat";
// a time zone option: { id, offset: minutes east (null: the host's own zone) }
const zoneOf = (tz) => {
  if (tz === undefined) {
    const jan = new Date(2026, 0, 1).getTimezoneOffset(), jul = new Date(2026, 6, 1).getTimezoneOffset();
    const id = jan === 0 && jul === 0 ? "UTC" : jan === jul && jan % 60 === 0 ? "Etc/GMT" + (jan > 0 ? "+" : "-") + Math.abs(jan / 60) : "Etc/Unknown";
    return { id, offset: null };
  }
  const s = String(tz);
  if (/^(etc\/)?(utc|gmt|uct|universal|zulu|greenwich)$|^etc\/gmt[+-]?0$/i.test(s)) return { id: "UTC", offset: 0 };
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(s);
  if (m && +m[2] < 24 && +(m[3] || 0) < 60) {
    const off = (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +(m[3] || 0));
    return { id: m[1] + m[2] + ":" + (m[3] || "00"), offset: off };
  }
  if (s === zoneOf().id) return zoneOf();
  throw new RangeError(`raea's portable Intl knows only UTC, fixed offsets and the host's zone, not the time zone ${s}`);
};

function DateTimeFormat(locales, options) {
  if (!new.target) return new DateTimeFormat(locales, options);
  setupDTF(this, locales, options, "any", "date");
}
// InitializeDateTimeFormat with ToDateTimeOptions' required and defaults ("any"|"date"|"time", "date"|"time"|"all")
const setupDTF = (self, locales, options, required, defaults) => {
  const o = toOptions(options);
  const locale = pick(locales);
  getOpt(o, "localeMatcher", ["lookup", "best fit"], "best fit", DTF);
  const cal = getOpt(o, "calendar", null, undefined, DTF);
  if (cal !== undefined && cal !== "gregory") throw new RangeError(`raea's portable Intl has only the gregory calendar, not ${cal}`);
  const nu = getOpt(o, "numberingSystem", null, undefined, DTF);
  if (nu !== undefined && nu !== "latn") throw new RangeError(`raea's portable Intl has only the latn numbering system, not ${nu}`);
  const hour12 = o.hour12 === undefined ? undefined : !!o.hour12;
  let hc = getOpt(o, "hourCycle", ["h11", "h12", "h23", "h24"], undefined, DTF);
  if (hour12 !== undefined) hc = null;
  const zone = zoneOf(o.timeZone);
  const req = {};
  const word = (k, allowed) => getOpt(o, k, allowed, undefined, DTF);
  const weekday = word("weekday", ["narrow", "short", "long"]);
  const era = word("era", ["narrow", "short", "long"]);
  const year = word("year", ["2-digit", "numeric"]);
  const month = word("month", ["2-digit", "numeric", "narrow", "short", "long"]);
  const day = word("day", ["2-digit", "numeric"]);
  const dayPeriod = word("dayPeriod", ["narrow", "short", "long"]);
  const hour = word("hour", ["2-digit", "numeric"]);
  const minute = word("minute", ["2-digit", "numeric"]);
  const second = word("second", ["2-digit", "numeric"]);
  const fsd = getNum(o, "fractionalSecondDigits", 1, 3, undefined);
  const tzn = word("timeZoneName", ["short", "long", "shortOffset", "longOffset", "shortGeneric", "longGeneric"]);
  getOpt(o, "formatMatcher", ["basic", "best fit"], "best fit", DTF);
  const dateStyle = word("dateStyle", ["full", "long", "medium", "short"]);
  const timeStyle = word("timeStyle", ["full", "long", "medium", "short"]);
  const anyField = [weekday, era, year, month, day, dayPeriod, hour, minute, second, fsd, tzn].some((x) => x !== undefined);
  if ((dateStyle || timeStyle) && anyField) throw new TypeError("Can't set option " + (dateStyle ? "dateStyle" : "timeStyle") + " when other date or time options are set");
  if (required === "date" && timeStyle) throw new TypeError("Invalid option : timeStyle");
  if (required === "time" && dateStyle) throw new TypeError("Invalid option : dateStyle");
  const s = (self._s = { locale, calendar: "gregory", numberingSystem: "latn", timeZone: zone.id, _offset: zone.offset });
  // the hour cycle: hour12 over hourCycle over the locale's
  const localeHc = locale === "en-GB" ? "h23" : "h12";
  const cycle = hour12 === true ? (locale === "en-GB" ? "h12" : "h12") : hour12 === false ? "h23" : hc || localeHc;
  const H = { h12: "h", h23: "H", h11: "K", h24: "k" }[cycle];
  let pattern;
  if (dateStyle || timeStyle) {
    const dp = dateStyle && STYLES[locale].date[dateStyle];
    let tp = timeStyle && TIME_STYLES[timeStyle];
    if (tp && H !== "h") tp = tp.replace(/h/, H === "K" ? "K" : H === "k" ? "kk" : "HH").replace(/ a/, "");
    else if (tp && H === "K") tp = tp.replace("h", "K");
    pattern = dp && tp ? dp + (dateStyle === "full" || dateStyle === "long" ? " 'at' " : ", ") + tp : dp || tp;
    s.dateStyle = dateStyle;
    s.timeStyle = timeStyle;
  } else {
    let need = true;
    if (required !== "time" && [weekday, year, month, day].some((x) => x !== undefined)) need = false;
    if (required !== "date" && [dayPeriod, hour, minute, second, fsd].some((x) => x !== undefined)) need = false;
    const d = { year, month, day }, t = { hour, minute, second };
    if (need && (defaults === "date" || defaults === "all")) d.year = d.month = d.day = "numeric";
    if (need && (defaults === "time" || defaults === "all")) t.hour = t.minute = t.second = "numeric";
    if (era) req.G = "G".repeat(era === "long" ? 4 : era === "narrow" ? 5 : 1);
    if (d.year) req.y = d.year === "2-digit" ? "yy" : "y";
    if (d.month) req.M = "M".repeat(WIDTHS[d.month]);
    if (weekday) req.E = "E".repeat(weekday === "short" ? 3 : WIDTHS[weekday]);
    if (d.day) req.d = d.day === "2-digit" ? "dd" : "d";
    if (t.hour) req.h = H.repeat(t.hour === "2-digit" ? 2 : 1);
    if (t.hour && dayPeriod && H === "h") req.B = "B".repeat(dayPeriod === "short" ? 1 : WIDTHS[dayPeriod]);
    if (!t.hour && dayPeriod) req.B = "B".repeat(dayPeriod === "short" ? 1 : WIDTHS[dayPeriod]);
    if (t.minute) req.m = t.minute === "2-digit" ? "mm" : "m";
    if (t.second) req.s = t.second === "2-digit" ? "ss" : "s";
    if (tzn) req.z = { short: "z", long: "zzzz", shortOffset: "O", longOffset: "OOOO", shortGeneric: "v", longGeneric: "vvvv" }[tzn];
    pattern = Object.keys(req).length ? patternFor(locale, req) : "";
    // en-GB's own 24-hour clock shows a numeric hour unpadded beside a 2-digit minute (3:04), as V8 has it
    if (locale === "en-GB" && H === "H" && hour12 === undefined && hour === "numeric" && minute === "2-digit") pattern = pattern.replace("HH", "H");
    if (fsd) pattern = /s/.test(pattern) ? pattern.replace(/(s+)/, "$1." + "S".repeat(fsd)) : pattern ? pattern + " " + "S".repeat(fsd) : "S".repeat(fsd);
  }
  // ICU puts a narrow no-break space before AM/PM (format turns it into a plain space, as V8 does; formatToParts keeps it)
  pattern = pattern.replace(/ a/g, "\u202fa");
  s._pattern = pattern;
  s._tokens = tokens(pattern);
  const has = (f) => s._tokens.some((t) => t.f !== undefined && fieldOf(t.f) === f);
  s._minutes = has("m");
  if (has("h")) { s.hourCycle = cycle; s.hour12 = cycle === "h12" || cycle === "h11"; }
  if (!dateStyle && !timeStyle) {
    for (const t of s._tokens) {
      if (t.f === undefined) continue;
      const f = fieldOf(t.f);
      const width = t.n === 1 ? "numeric" : t.n === 2 ? "2-digit" : t.n === 3 ? "short" : t.n === 4 ? "long" : "narrow";
      if (f === "G") s.era = t.n === 4 ? "long" : t.n === 5 ? "narrow" : "short";
      else if (f === "y") s.year = t.n === 2 ? "2-digit" : "numeric";
      else if (f === "M") s.month = width;
      else if (f === "E") s.weekday = t.n === 4 ? "long" : t.n === 5 ? "narrow" : "short";
      else if (f === "d") s.day = width;
      else if (f === "B") s.dayPeriod = t.n === 4 ? "long" : t.n === 5 ? "narrow" : "short";
      else if (f === "h") s.hour = width;
      else if (f === "m") s.minute = width;
      else if (f === "s") s.second = width;
      else if (f === "S") s.fractionalSecondDigits = t.n;
      else if (f === "z" || f === "O" || f === "v") s.timeZoneName = tzn;
    }
  }
};
const pad = (n, w) => String(n).padStart(w, "0");
const zoneName = (form, off) => {
  if (off === 0) return form === "z" ? "UTC" : form === "zzzz" ? "Coordinated Universal Time" : "GMT";
  const a = Math.abs(off), h = Math.floor(a / 60), m = a % 60, sg = off < 0 ? "-" : "+";
  return form === "zzzz" || form === "OOOO" || form === "vvvv" ? `GMT${sg}${pad(h, 2)}:${pad(m, 2)}` : `GMT${sg}${h}${m ? ":" + pad(m, 2) : ""}`;
};
const dayPeriodOf = (h, m) => (h === 12 && m === 0 ? "noon" : h < 12 ? "in the morning" : h >= 12 && h < 18 ? "in the afternoon" : h >= 18 && h < 21 ? "in the evening" : "at night");
const DATE_TYPES = { G: "era", y: "year", M: "month", L: "month", E: "weekday", c: "weekday", d: "day", a: "dayPeriod", B: "dayPeriod", h: "hour", H: "hour", k: "hour", K: "hour", m: "minute", s: "second", S: "fractionalSecond", z: "timeZoneName", O: "timeZoneName", v: "timeZoneName" };
const dateParts = (s, x) => {
  const t = x === undefined ? Date.now() : Number(x instanceof Date ? x.getTime() : x);
  if (!isFinite(t) || Math.abs(t) > 8.64e15) throw new RangeError("Invalid time value");
  const tv = Math.trunc(t) + 0;
  const off = s._offset === null ? -new Date(tv).getTimezoneOffset() : s._offset;
  const d = new Date(tv + off * 60000);
  const Y = d.getUTCFullYear(), Mo = d.getUTCMonth(), D = d.getUTCDate(), W = d.getUTCDay(), h = d.getUTCHours(), mi = d.getUTCMinutes(), se = d.getUTCSeconds(), ms = d.getUTCMilliseconds();
  const gb = s.locale === "en-GB";
  const out = [];
  for (const tk of s._tokens) {
    if (tk.lit !== undefined) {
      if (out.length && out[out.length - 1].type === "literal") out[out.length - 1].value += tk.lit;
      else out.push({ type: "literal", value: tk.lit });
      continue;
    }
    const n = tk.n;
    let v;
    switch (tk.f) {
      case "G": v = Y > 0 ? (n === 4 ? "Anno Domini" : n === 5 ? "A" : "AD") : n === 4 ? "Before Christ" : n === 5 ? "B" : "BC"; break;
      case "y": { const yy = Y > 0 ? Y : 1 - Y; v = n === 2 ? pad(yy % 100, 2) : String(yy); break; }
      case "M": case "L": v = n >= 3 ? (n === 3 ? MONTHS[Mo].slice(0, 3) : n === 4 ? MONTHS[Mo] : MONTHS[Mo][0]) : pad(Mo + 1, n); break;
      case "E": case "c": v = n === 4 ? DAYS[W] : n === 5 ? DAYS[W][0] : n === 6 ? DAYS[W].slice(0, 2) : DAYS[W].slice(0, 3); break;
      case "d": v = pad(D, n); break;
      case "a": v = h < 12 ? (gb ? "am" : "AM") : gb ? "pm" : "PM"; break;
      case "B": v = dayPeriodOf(h, s._minutes ? mi : 0); break;
      case "h": v = pad(h % 12 || 12, n); break;
      case "K": v = pad(h % 12, n); break;
      case "H": v = pad(h, n); break;
      case "k": v = pad(h || 24, n); break;
      case "m": v = pad(mi, n); break;
      case "s": v = pad(se, n); break;
      case "S": v = pad(ms, 3).slice(0, n); break;
      case "z": case "O": case "v": v = zoneName(tk.f.repeat(n), off); break;
      default: v = "";
    }
    out.push({ type: DATE_TYPES[tk.f], value: v });
  }
  return out;
};
boundGetter(DateTimeFormat, "format", function (x) { return joinParts(dateParts(this._s, x)).replace(/\u202f/g, " "); });
Object.assign(DateTimeFormat.prototype, {
  formatToParts(x) { return dateParts(this._s, x); },
  formatRange(a, b) {
    if (a === undefined || b === undefined) throw new TypeError("startDate or endDate is undefined");
    const x = this.format(a), y = this.format(b);
    return x === y ? x : x + " – " + y;
  },
  resolvedOptions() {
    const s = this._s, r = {};
    for (const k of ["locale", "calendar", "numberingSystem", "timeZone", "hourCycle", "hour12", "weekday", "era", "year", "month", "day", "dayPeriod", "hour", "minute", "second", "fractionalSecondDigits", "timeZoneName", "dateStyle", "timeStyle"]) if (s[k] !== undefined) r[k] = s[k];
    return r;
  },
});
brand(DateTimeFormat, DTF);

// ---- Intl and the locale-aware built-ins ---------------------------------------------------------------------------
const Intl = {};
for (const [k, v] of Object.entries({ NumberFormat, DateTimeFormat, PluralRules, RelativeTimeFormat, ListFormat, Collator })) Object.defineProperty(Intl, k, { value: v, writable: true, configurable: true });
Object.defineProperty(Intl, "getCanonicalLocales", { value: function getCanonicalLocales(l) { return [...new Set(localeList(l))]; }, writable: true, configurable: true });
Object.defineProperty(Intl, Symbol.toStringTag, { value: "Intl", configurable: true });
Object.defineProperty(g, "Intl", { value: Intl, writable: true, configurable: true, enumerable: false });

// one formatter per locale and options, kept: a counter formatted every frame makes its formatter once
const cached = (make) => {
  const cache = new Map();
  return (locales, options) => {
    let key = null;
    if ((locales === undefined || typeof locales === "string") && (options === undefined || (options !== null && typeof options === "object"))) {
      try { key = (locales || "") + "\u0000" + (options === undefined ? "" : JSON.stringify(options)); } catch { key = null; }
    }
    if (key === null) return make(locales, options);
    let f = cache.get(key);
    if (f === undefined) {
      f = make(locales, options);
      if (cache.size < 64) cache.set(key, f);
    }
    return f;
  };
};
const method = (proto, name, fn) => Object.defineProperty(proto, name, { value: { [name]: fn }[name], writable: true, configurable: true });
const nf = cached((l, o) => new NumberFormat(l, o));
method(Number.prototype, "toLocaleString", function (locales, options) {
  if (typeof this !== "number" && !(this instanceof Number)) throw new TypeError("Number.prototype.toLocaleString requires that 'this' be a Number");
  return nf(locales, options).format(Number(this));
});
if (typeof BigInt !== "undefined") method(BigInt.prototype, "toLocaleString", function (locales, options) {
  return nf(locales, options).format(BigInt.prototype.valueOf.call(this));
});
const dtf = { any: cached((l, o) => { const f = Object.create(DateTimeFormat.prototype); setupDTF(f, l, o, "any", "all"); return f; }),
  date: cached((l, o) => { const f = Object.create(DateTimeFormat.prototype); setupDTF(f, l, o, "date", "date"); return f; }),
  time: cached((l, o) => { const f = Object.create(DateTimeFormat.prototype); setupDTF(f, l, o, "time", "time"); return f; }) };
for (const [name, kind] of [["toLocaleString", "any"], ["toLocaleDateString", "date"], ["toLocaleTimeString", "time"]]) {
  method(Date.prototype, name, function (locales, options) {
    const t = Date.prototype.getTime.call(this);
    if (t !== t) return "Invalid Date";
    return dtf[kind](locales, options).format(t);
  });
}
const coll = cached((l, o) => new Collator(l, o));
method(String.prototype, "localeCompare", function (that, locales, options) {
  if (this === null || this === undefined) throw new TypeError("String.prototype.localeCompare called on null or undefined");
  return coll(locales, options).compare(String(this), String(that));
});
const upper = String.prototype.toUpperCase, lower = String.prototype.toLowerCase;
method(String.prototype, "toLocaleUpperCase", function (locales) { pick(locales); return upper.call(this); });
method(String.prototype, "toLocaleLowerCase", function (locales) { pick(locales); return lower.call(this); });
method(Array.prototype, "toLocaleString", function (locales, options) {
  const a = Object(this), n = a.length >>> 0;
  let out = "";
  for (let i = 0; i < n; i++) {
    if (i) out += ",";
    const x = a[i];
    if (x !== undefined && x !== null) out += String(x.toLocaleString(locales, options));
  }
  return out;
});
})(globalThis);
