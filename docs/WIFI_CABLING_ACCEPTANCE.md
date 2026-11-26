# Wi-Fi cabling: acceptance criteria

These are the measurable checks that decide whether the cabling feature is ready
for client work. **Status** says what has been shown; nothing here claims the
feature is validated on real buildings.

| # | Criterion | How it is measured | Status |
| --- | --- | --- | --- |
| 1 | Software correctness | Automated tests (`npm test`), worker tests, service tests, production build | Met: all pass at the time of writing |
| 2 | Length limits | Every permanent link <= 90 m and channel <= 100 m, or flagged as an error | Met in tests |
| 3 | PoE | Voltage at the AP and cable loss calculated for every run; failures flagged | Met in tests. Figures to be checked against the IEEE standard and datasheets |
| 4 | Tray and riser capacity | Fill within the limit, or flagged with the width needed | Met in tests |
| 5 | Rack engineering | Space, power and cooling checked per rack | Met in tests |
| 6 | Stable results | The same input gives the same design; an incremental change gives the same answer as a fresh calculation | Met in tests |
| 7 | Traceability | Every BoQ line states how it was calculated and where its value came from; every change is in the audit trail | Met in tests |
| 8 | Honest labelling | Anything resting on an assumption is flagged "estimated"; approval level shown in every report | Met in tests |
| 9 | Existing features unchanged | The Wi-Fi prediction, optimiser and report tests keep passing | Met |
| 10 | Cable length accuracy | Calculated permanent link compared with **measured** links on real buildings: target within 10 % (or 3 m) for at least 90 % of links | **Not yet measured** |
| 11 | Route realism | A site engineer reviews routes on at least three real floor plans and confirms they are installable | **Not yet done** |
| 12 | Large buildings | 20 floors and 2,000 APs complete in an agreed time on the target hardware, without freezing the page | **Measured, not yet accepted** (`node scripts/bench-cabling.mjs`, synthetic buildings, no agreed target). 100 APs: 8 s. 500 APs on 10 floors: 21 s. 2,000 APs on 50 floors: 68 s. 2,000 APs on 20 floors: 181 s (rack suggestion 140 s, design 41 s). The design runs in a Web Worker; rack suggestion does not yet |
| 13 | Catalogue | Every part in a delivered BoQ uses manufacturer values (no "illustrative" lines) | **Not met**: placeholders until the client's datasheets are entered |
| 14 | Office files | Excel and PowerPoint files open and look right in Microsoft Office | **Not yet checked** |
| 15 | Standards | PoE and cabling figures reviewed against the current IEEE 802.3 and TIA/ISO editions | **Not yet done** |

## Reference buildings

To close criteria 10, 11 and 12 the project needs, for each of at least three real
buildings: the drawings (DWG/DXF or vector PDF), measured permanent-link lengths
from a certifier (the field-test import takes a CSV), the cable pathway drawings
(trays, risers, ceiling access), and the equipment datasheets.

## What the tool will never claim

It does not certify cabling, replace a site survey, or measure signal quality.
