# Wi-Fi planning and design report (.docx)

The **Report** button in the editor header builds a Word document from the saved
prediction run (and the saved optimisation run, when there is one). It reads the
per-AP signal grids the simulator already produced and does not run any ray
tracing.

Code: `src/utils/reportBuilder.js` (sections), `reportData.js` (calculations,
unit-tested in `test/reportData.test.js`), `reportImages.js` (floor images and
CDF charts), `docxBuilder.js` (file format, header/footer, contents list).

## Sections

Sections the project has no data for are skipped, and the later sections are
renumbered. What was skipped is listed under *Not available for this project*
in the last numbered section.

| Section | Needs |
|---|---|
| Executive summary | a prediction |
| Building and floor plan analysis | rooms (walls, materials, doors, windows when drawn) |
| Wi-Fi infrastructure | Wi-Fi APs |
| RF coverage analysis (per band, coverage at several thresholds, CDF) | a prediction |
| Primary and secondary AP coverage, single-AP zones | 2 or more APs in a band |
| Channel and interference planning | 2 or more APs with channel data |
| AP placement and installation design | APs (optimisation result used when present) |
| AP optimisation and minimum AP count | an optimisation run |
| Room-level analysis | rooms |
| Weak zones and problem areas | a prediction |
| Validation and acceptance | measured RSSI logs on the floor (otherwise marked pending) |
| Final recommendations, methodology, consistency checks | always |
| Appendix A: each AP alone; Appendix B: adding APs one by one with CDF | a prediction |

## Conventions

* Bands are analysed separately and never combined. The overlap, room and
  weak-zone sections use the band with the most APs.
* The *design threshold* is the optimisation threshold when an optimisation
  was run, otherwise the prediction's weak-signal threshold. Coverage is also
  given at the planning profiles in `DEFAULT_PROFILES` (-67, -70, -75 dBm), which
  are editable assumptions. Each figure names the threshold it uses.
* Coverage = share of target-grid cells whose strongest AP reaches the
  threshold. The target grid is the cells inside rooms and the building
  boundary, minus rooms marked as not a receiver area.
* The calculation checks table compares the area bases (room polygons,
  boundary, carpet area, prediction grid, optimisation target) and flags a
  difference above 1% between the prediction grid and the optimiser's target.
* The co-channel detection level (`DEFAULT_DETECT_DBM`, -82 dBm) is an
  assumption, passed to `buildReport` as `detectDbm`.

## Not supported by the project data today

* SNR, SINR and noise-floor maps (the simulator reports received power only)
* Interference levels and airtime
* Capacity planning: clients, density, applications, bandwidth, AP load
* Roaming validation and 802.11k/v/r support
* PoE budget, switch ports and cabling
* Hardware model recommendations beyond the AP profile entered in the project
* Predicted-versus-measured SNR; RSSI validation needs measured logs
* High-density area detection
