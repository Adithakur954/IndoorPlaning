// The same plan with every Wi-Fi AP on one band, for the 2.4 GHz vs 5 GHz
// comparison. Positions, heights and walls stay the same; only the radio
// settings change (taken from the AP's own profile, else assumed defaults).
import { channelCenterMHz, getProfiles } from "../config/apProfiles.js";

export const COMPARED_BANDS = ["2.4", "5"];
const FALLBACK = {
  "2.4": { txPowerDbm: 20, gainDbi: 3, channel: 6, widthMHz: 20 },
  5: { txPowerDbm: 20, gainDbi: 3, channel: 36, widthMHz: 20 },
};

export function radioFor(plan, source, band) {
  const profiles = getProfiles(plan);
  const profile = profiles.find((p) => p.id === source.profileId) || profiles[0];
  const cfg = profile?.bands?.[band];
  const c = cfg || FALLBACK[band];
  return {
    profileId: profile?.id,
    band: String(band),
    technology: "Wi-Fi",
    antennaPattern: "omni",
    txPowerDbm: Number(c.txPowerDbm),
    antennaGainDbi: Number(c.gainDbi || 0),
    freqMHz: channelCenterMHz(band, c.channel),
    channel: Number(c.channel),
    bandwidthMHz: Number(c.widthMHz),
    assumed: !cfg, // the profile has no radio on this band: defaults were used
  };
}

export function planForBand(plan, band) {
  const sources = plan.sources
    .filter((s) => s.kind === "wifi")
    .map((s) => {
      const { assumed, ...fields } = radioFor(plan, s, band); // eslint-disable-line no-unused-vars
      return { ...s, ...fields };
    });
  return { ...plan, sources };
}

export const bandsAssumed = (plan, band) =>
  plan.sources.some((s) => s.kind === "wifi" && radioFor(plan, s, band).assumed);
