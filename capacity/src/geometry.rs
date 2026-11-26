//! Plan geometry: rooms, outlines and areas as polygons in plan metres (x, z).

use crate::js::{is_str, max_all, min_all, num, truthy};
use serde_json::Value;

pub type P = (f64, f64);

#[derive(Clone, Copy, Debug)]
pub struct BBox {
    pub min_x: f64,
    pub max_x: f64,
    pub min_z: f64,
    pub max_z: f64,
}

fn coord(p: &Value, key: &str, idx: usize) -> f64 {
    // Number(p.x ?? p[0])
    let first = match p {
        Value::Object(m) => m.get(key).filter(|v| !v.is_null()),
        _ => None,
    };
    match first {
        Some(v) => num(Some(v)),
        None => num(match p {
            Value::Array(a) => a.get(idx),
            Value::Object(m) => m.get(&idx.to_string()),
            _ => None,
        }),
    }
}

/// The corners of a room-like shape: polygon, circle (48 points) or rectangle.
pub fn points_of(r: &Value) -> Vec<P> {
    let shape = r.get("shape");
    if is_str(shape, "polygon") {
        if let Some(Value::Array(pp)) = r.get("polygonPoints") {
            if pp.len() >= 3 {
                return pp.iter().map(|p| (coord(p, "x", 0), coord(p, "z", 1))).collect();
            }
        }
    }
    let x = num(r.get("x"));
    let z = num(r.get("z"));
    let w = num(r.get("width"));
    let d = num(r.get("depth"));
    if is_str(shape, "circle") {
        let radius = if truthy(r.get("radius")) { num(r.get("radius")) } else { w / 2.0 };
        return (0..48)
            .map(|i| {
                let a = (f64::from(i) * std::f64::consts::PI) / 24.0;
                (x + w / 2.0 + radius * libm::cos(a), z + d / 2.0 + radius * libm::sin(a))
            })
            .collect();
    }
    vec![(x, z), (x + w, z), (x + w, z + d), (x, z + d)]
}

pub fn area(p: &[P]) -> f64 {
    let n = p.len();
    let mut sum = 0.0;
    for i in 0..n {
        let q = p[(i + 1) % n];
        sum = sum + p[i].0 * q.1 - q.0 * p[i].1;
    }
    sum.abs() / 2.0
}

/// Even-odd ray test.
pub fn inside(x: f64, z: f64, p: &[P]) -> bool {
    let n = p.len();
    if n == 0 {
        return false;
    }
    let mut yes = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, zi) = p[i];
        let (xj, zj) = p[j];
        if (zi > z) != (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi {
            yes = !yes;
        }
        j = i;
    }
    yes
}

pub fn bbox(p: &[P]) -> BBox {
    BBox {
        min_x: min_all(p.iter().map(|q| q.0)),
        max_x: max_all(p.iter().map(|q| q.0)),
        min_z: min_all(p.iter().map(|q| q.1)),
        max_z: max_all(p.iter().map(|q| q.1)),
    }
}

/// A building outline as a polygon shape.
pub fn boundary_points(b: &Value) -> Vec<P> {
    let mut shape = serde_json::Map::new();
    shape.insert("shape".into(), Value::String("polygon".into()));
    shape.insert("polygonPoints".into(), b.get("points").cloned().unwrap_or(Value::Null));
    points_of(&Value::Object(shape))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rectangle_area_and_inside() {
        let p = points_of(&json!({ "shape": "rectangle", "x": 0, "z": 0, "width": 10, "depth": 4 }));
        assert_eq!(area(&p), 40.0);
        assert!(inside(5.0, 2.0, &p));
        assert!(!inside(11.0, 2.0, &p));
    }

    #[test]
    fn polygon_from_pairs_and_objects() {
        let a = points_of(&json!({ "shape": "polygon", "polygonPoints": [[0, 0], [4, 0], [0, 4]] }));
        let b = points_of(&json!({ "shape": "polygon", "polygonPoints": [{ "x": 0, "z": 0 }, { "x": 4, "z": 0 }, { "x": 0, "z": 4 }] }));
        assert_eq!(a, b);
        assert_eq!(area(&a), 8.0);
    }
}
