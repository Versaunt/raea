//! The portable Intl (src/intl.js) on QuickJS, through host::install as a composition gets it: each case in
//! tests/intl/cases.json is a JS expression and the JSON of what Node's ICU (Chrome's V8 and ICU) answers for it, or
//! "throws <Error>"; every one must come out the same. Regenerate with `TZ=UTC node tests/intl/gen.mjs`.
#![cfg(any(feature = "portable", not(target_vendor = "apple")))]
use std::cell::RefCell;
use std::rc::Rc;

use raea_runtime_jsengine::{Engine, JsEngine, Ret, arg};

const CASES: &str = include_str!("intl/cases.json");

// a QuickJS context with host::install's shims and `__report(text)` kept in the returned cell
fn quickjs() -> (Box<dyn JsEngine>, Rc<RefCell<Vec<String>>>) {
    let mut js = Engine::QuickJs.start().unwrap();
    let seen = Rc::new(RefCell::new(Vec::new()));
    let s = seen.clone();
    js.native("__report", Box::new(move |a: &[String]| { s.borrow_mut().push(arg(a, 0).to_string()); Ok(Ret::Undefined) })).unwrap();
    (js, seen)
}

#[test]
fn intl_answers_as_chrome_does() {
    let (mut js, seen) = quickjs();
    raea_native::host::install(&mut *js).unwrap();
    js.eval(&format!("globalThis.__cases = {CASES};"), "cases.json").unwrap();
    // cases in the host's own zone were made on UTC: run only where this host is on UTC too
    js.eval(
        r#"(() => {
  const utc = new Date(2026, 0, 1).getTimezoneOffset() === 0 && new Date(2026, 6, 1).getTimezoneOffset() === 0;
  const local = (c) => (/toLocale(Date|Time)?String\(/.test(c) && /new Date\(/.test(c) && !/timeZone/.test(c)) || /DateTimeFormat\(\)/.test(c);
  let ok = 0, skipped = 0;
  const bad = [];
  for (const [code, want] of __cases) {
    if (!utc && local(code)) { skipped++; continue; }
    let got;
    try { got = JSON.stringify((0, eval)(code)); } catch (e) { got = "throws " + e.constructor.name + ": " + e.message; }
    if (got === want || (want.startsWith("throws ") && got.startsWith(want + ":"))) ok++;
    else bad.push(code + "\n    want " + want + "\n    got  " + got);
  }
  __report(JSON.stringify({ ok, total: __cases.length, skipped, bad }));
})();"#,
        "run.js",
    )
    .unwrap();
    let out: serde_json::Value = serde_json::from_str(&seen.borrow()[0]).unwrap();
    let bad = out["bad"].as_array().unwrap();
    for b in bad {
        println!("{}", b.as_str().unwrap());
    }
    println!("intl: {} of {} cases as Node's ICU answers them ({} skipped off UTC)", out["ok"], out["total"], out["skipped"]);
    assert!(bad.is_empty(), "{} cases differ from Node's ICU", bad.len());
}

#[test]
fn intl_leaves_a_real_one_alone() {
    let (mut js, seen) = quickjs();
    js.eval("globalThis.Intl = { real: true }; const n = Number.prototype.toLocaleString;", "real.js").unwrap();
    js.eval(raea_native::INTL_JS, "intl.js").unwrap();
    js.eval("__report(String(Intl.real === true && Number.prototype.toLocaleString === n));", "check.js").unwrap();
    assert_eq!(seen.borrow()[0], "true");
}
