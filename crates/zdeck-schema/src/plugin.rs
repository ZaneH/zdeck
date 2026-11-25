//! Pure plugin identifier and JSON safe-integer primitives.
use serde_json::Value;

const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Lowercase, bounded plugin/action/argument identifier; never a path.
pub fn identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
/// Integer-valued JSON number within JavaScript's safe integer range.
pub fn integer(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= SAFE_INTEGER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identifiers_are_bounded_and_not_paths() {
        for id in ["a", "set-volume", "a0", &"a".repeat(64)] {
            assert!(identifier(id));
        }
        for id in ["", "A", "0a", "../node", "a_b", "é", &"a".repeat(65)] {
            assert!(!identifier(id));
        }
    }

    #[test]
    fn integers_match_javascript_safe_bounds() {
        for value in [json!(0), json!(-0.0), json!(1.0), json!(9007199254740991i64), json!(-9007199254740991i64)] {
            assert!(integer(&value).is_some());
        }
        for value in [json!(9007199254740992i64), json!(-9007199254740992i64), json!(1.5), json!("1"), json!(null), json!(true)] {
            assert!(integer(&value).is_none());
        }
    }
}
