import test from "node:test";
import assert from "node:assert/strict";
import { COMPARED_BANDS, planForBand, radioFor } from "../src/utils/bandVariants.js";

const plan = {
  floors: [],
  apProfiles: [
    {
      id: "p",
      name: "P",
      bands: {
        2.4: { txPowerDbm: 18, gainDbi: 4, channel: 6, widthMHz: 20 },
        5: { txPowerDbm: 20, gainDbi: 4.5, channel: 36, widthMHz: 40 },
      },
    },
  ],
  sources: [
    { id: "a", kind: "wifi", profileId: "p", x: 1, z: 2, heightM: 2.5, band: "5", freqMHz: 5180 },
    { id: "b", kind: "cellular", x: 3, z: 3 },
  ],
};

test("the same AP is placed on each band with that band's radio settings", () => {
  assert.deepEqual(COMPARED_BANDS, ["2.4", "5"]);
  const low = planForBand(plan, "2.4").sources;
  const high = planForBand(plan, "5").sources;
  assert.equal(low.length, 1); // only Wi-Fi sources take part
  assert.deepEqual([low[0].x, low[0].z, low[0].heightM], [1, 2, 2.5]);
  assert.deepEqual([low[0].freqMHz, low[0].channel, low[0].txPowerDbm, low[0].bandwidthMHz], [2437, 6, 18, 20]);
  assert.deepEqual([high[0].freqMHz, high[0].channel, high[0].bandwidthMHz], [5180, 36, 40]);
  assert.equal(low[0].band, "2.4");
  assert.equal("assumed" in low[0], false);
});

test("a profile without a radio on the band falls back to marked defaults", () => {
  const p = { ...plan, apProfiles: [{ id: "p", name: "P", bands: { 5: plan.apProfiles[0].bands[5] } }] };
  const r = radioFor(p, p.sources[0], "2.4");
  assert.equal(r.assumed, true);
  assert.equal(r.channel, 6);
});
