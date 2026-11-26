//! JavaScript value semantics the engine depends on.
//!
//! The plan comes from the planner as JSON and was written for a JavaScript
//! engine, so coercion (`Number(x)`, `a || b`, `String(x)`), `Math.round`,
//! `Math.hypot`, `Math.min` with NaN and number formatting are reproduced
//! here. That keeps the results identical to the previous JavaScript engine.

use serde_json::Value;
use std::cmp::Ordering;

/// `Number(v)`; `None` stands for `undefined`.
pub fn num(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => str_to_num(s),
        Some(Value::Array(a)) => match a.len() {
            0 => 0.0,
            1 => match &a[0] {
                Value::Array(_) | Value::Object(_) => f64::NAN,
                Value::Null => 0.0,
                other => num(Some(other)),
            },
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn str_to_num(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ if t.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) => t.parse().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// `Number.isFinite(v) ? v : None`, without coercion.
pub fn finite(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()),
        _ => None,
    }
}

pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `a || b`
pub fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(a) {
        a
    } else {
        b
    }
}

/// `String(v)`
pub fn to_str(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => fmt_num(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| if x.is_null() { String::new() } else { to_str(Some(x)) })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `a === b` for JSON values (objects and arrays are never equal: no identity).
pub fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

pub fn is_str(v: Option<&Value>, s: &str) -> bool {
    matches!(v, Some(Value::String(x)) if x == s)
}

/// `Number.prototype.toString()`
pub fn fmt_num(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x == 0.0 {
        return "0".into();
    }
    let a = x.abs();
    if !(1e-6..1e21).contains(&a) {
        let s = format!("{x:e}");
        let (m, e) = s.split_once('e').unwrap_or((&s, "0"));
        let e: i32 = e.parse().unwrap_or(0);
        return format!("{m}e{}{}", if e >= 0 { "+" } else { "-" }, e.abs());
    }
    format!("{x}")
}

/// `Math.round`: halves go up (towards +infinity).
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// `Math.round(x * 10) / 10`
pub fn r1(x: f64) -> f64 {
    round(x * 10.0) / 10.0
}

/// V8's `Math.hypot`: scaled, Kahan-compensated sum of squares.
pub fn hypot(a: f64, b: f64) -> f64 {
    let (a, b) = (a.abs(), b.abs());
    if a.is_infinite() || b.is_infinite() {
        return f64::INFINITY;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    let max = if a > b { a } else { b };
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut comp) = (0.0f64, 0.0f64);
    for v in [a, b] {
        let n = v / max;
        let summand = n * n - comp;
        let preliminary = sum + summand;
        comp = (preliminary - sum) - summand;
        sum = preliminary;
    }
    libm::sqrt(sum) * max
}

/// `Math.min(a, b)` (NaN wins)
pub fn min2(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if b < a {
        b
    } else {
        a
    }
}

/// `Math.max(a, b)` (NaN wins)
pub fn max2(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if b > a {
        b
    } else {
        a
    }
}

/// `Math.min(...xs)`
pub fn min_all(xs: impl IntoIterator<Item = f64>) -> f64 {
    xs.into_iter().fold(f64::INFINITY, min2)
}

/// `Math.max(...xs)`
pub fn max_all(xs: impl IntoIterator<Item = f64>) -> f64 {
    xs.into_iter().fold(f64::NEG_INFINITY, max2)
}

pub fn log10(x: f64) -> f64 {
    libm::log10(x)
}

/// `a.localeCompare(b)` approximated by the ICU root collation for ASCII:
/// spaces and punctuation, then symbols, digits, letters (case-insensitive
/// first, lower case before upper case on a tie).
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    const ORDER: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789";
    let primary = |c: char| -> u32 {
        if let Some(i) = ORDER.find(c) {
            i as u32
        } else if c.is_ascii_alphabetic() {
            100 + (c.to_ascii_lowercase() as u32 - 'a' as u32)
        } else {
            1000 + c as u32
        }
    };
    let pa: Vec<u32> = a.chars().map(primary).collect();
    let pb: Vec<u32> = b.chars().map(primary).collect();
    match pa.cmp(&pb) {
        Ordering::Equal => {
            let tier = |c: char| u8::from(c.is_ascii_uppercase());
            a.chars().map(tier).cmp(b.chars().map(tier))
        }
        o => o,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rounding_and_formatting() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(fmt_num(255.0), "255");
        assert_eq!(fmt_num(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(fmt_num(1e-7), "1e-7");
        assert_eq!(fmt_num(1.5e21), "1.5e+21");
        assert_eq!(fmt_num(-0.0), "0");
    }

    #[test]
    fn coercion() {
        assert!(num(None).is_nan());
        assert_eq!(num(Some(&json!(null))), 0.0);
        assert_eq!(num(Some(&json!(" 12.5 "))), 12.5);
        assert!(num(Some(&json!("12px"))).is_nan());
        assert!(truthy(Some(&json!("x"))));
        assert!(!truthy(Some(&json!(0))));
        assert_eq!(to_str(Some(&json!(5))), "5");
    }

    #[test]
    fn hypot_matches_v8() {
        assert_eq!(hypot(3.0, 4.0), 5.0);
        assert_eq!(hypot(0.0, 0.0), 0.0);
        assert!(hypot(f64::NAN, 1.0).is_nan());
    }

    #[test]
    fn collation() {
        assert_eq!(locale_cmp("a", "B"), Ordering::Less);
        assert_eq!(locale_cmp("a", "A"), Ordering::Less);
        assert_eq!(locale_cmp("a-1", "a1"), Ordering::Less);
        assert_eq!(locale_cmp("ap2", "ap10"), Ordering::Greater);
    }
}
