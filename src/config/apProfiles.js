// AP profiles: editable radio and mounting settings for an access-point model.
// The ion4i entry is only a ready-made template filled from the HFCL datasheet
// (29 Mar 2024). Every value can be edited per project; nothing is hard-wired.

export const ION4I_PROFILE = {
  id: "ion4i",
  name: "HFCL ion4i (Wi-Fi 5, 2x2:2)",
  model: "ion4i",
  note: "Template from the HFCL datasheet (29 Mar 2024). Max transmit power is 27 dBm per band and depends on country rules; the configured power below is an editable default, not the datasheet maximum.",
  antenna: "omni",
  mounting: ["wall", "ceiling"],
  sizeMm: [175, 175, 37],
  bands: {
    2.4: {
      txPowerDbm: 20,
      maxTxPowerDbm: 27,
      gainDbi: 4,
      channel: 6,
      widthMHz: 20,
    },
    5: {
      txPowerDbm: 20,
      maxTxPowerDbm: 27,
      gainDbi: 4.5,
      channel: 36,
      widthMHz: 40,
    },
  },
};

export const BANDS = ["2.4", "5", "6"];

// Centre frequency of a 20 MHz channel number in each band.
export function channelCenterMHz(band, channel) {
  const n = Number(channel);
  if (String(band) === "2.4") return n === 14 ? 2484 : 2407 + 5 * n;
  if (String(band) === "5") return 5000 + 5 * n;
  return 5950 + 5 * n;
}

export const eirpDbm = (config) =>
  Number(config.txPowerDbm) + Number(config.gainDbi || 0);

export const getProfiles = (plan) =>
  plan.apProfiles?.length ? plan.apProfiles : [ION4I_PROFILE];

// Source fields for an AP built from a profile and band.
export function sourceFieldsFromProfile(profile, band) {
  const config = profile.bands[band];
  if (!config) throw Error(`${profile.name} has no ${band} GHz radio`);
  return {
    profileId: profile.id,
    band: String(band),
    technology: "Wi-Fi",
    antennaPattern: "omni",
    txPowerDbm: Number(config.txPowerDbm),
    antennaGainDbi: Number(config.gainDbi || 0),
    freqMHz: channelCenterMHz(band, config.channel),
    channel: Number(config.channel),
    bandwidthMHz: Number(config.widthMHz),
  };
}

// Problems with a profile's band settings, shown next to the editor.
export function profileWarnings(profile, band) {
  const config = profile.bands[band];
  if (!config) return [];
  const out = [];
  if (config.maxTxPowerDbm != null && config.txPowerDbm > config.maxTxPowerDbm)
    out.push(
      `Transmit power ${config.txPowerDbm} dBm is above the model's ${config.maxTxPowerDbm} dBm maximum.`,
    );
  if (eirpDbm(config) > 36)
    out.push(
      `EIRP ${eirpDbm(config).toFixed(1)} dBm may exceed local regulatory limits; check your country's rules.`,
    );
  return out;
}
