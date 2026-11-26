//! `apsearch <dir>`: reads `<dir>/params.json` and `<dir>/hit.u8` (K x N, row-major, 1 = the candidate reaches
//! the cell's requirement), runs the AP placement search and writes `<dir>/result.json`. Called by the
//! simulation worker (Python) after it ray-traced the candidates; see capacity/src/apsearch.rs.
use capacity_core::apsearch::{input_from, output_json, search};
use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: apsearch <dir with params.json and hit.u8>");
        std::process::exit(2);
    }));
    let run = || -> Result<(), String> {
        let params: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("params.json")).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let hit = std::fs::read(dir.join("hit.u8")).map_err(|e| e.to_string())?;
        let input = input_from(&params, &hit)?;
        let out = output_json(&search(&input));
        std::fs::write(dir.join("result.json"), out.to_string()).map_err(|e| e.to_string())
    };
    if let Err(e) = run() {
        eprintln!("apsearch: {e}");
        std::process::exit(1);
    }
}
