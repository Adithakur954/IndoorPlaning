// Ethernet / PoE electrical checks for one cable run. Pure functions.
//
// Ethernet is digital: the cable's length limit (90 m permanent link, 100 m
// channel) keeps signal loss, return loss and crosstalk within the category's
// limits when the cable meets its standard. Cable certification needs field
// test equipment, which this tool cannot replace. What a planning tool CAN
// check is the electrical side of PoE: the copper's resistance drops voltage
// and wastes power, and the AP must still receive enough.
//
// The PoE figures are nominal values of IEEE 802.3; confirm them against the
// edition in force and the switch and AP datasheets.

// pairs: how many pairs carry current each way (2 = one pair out, one back;
// 4 = two pairs out, two back).
export const POE_TYPES = {
  af: { name: "802.3af (Type 1)", pseVoltageV: 44, psePowerW: 15.4, pdPowerW: 12.95, pdMinVoltageV: 37, pairs: 2 },
  at: { name: "802.3at (Type 2)", pseVoltageV: 50, psePowerW: 30, pdPowerW: 25.5, pdMinVoltageV: 42.5, pairs: 2 },
  bt3: { name: "802.3bt (Type 3)", pseVoltageV: 50, psePowerW: 60, pdPowerW: 51, pdMinVoltageV: 42.5, pairs: 4 },
  bt4: { name: "802.3bt (Type 4)", pseVoltageV: 52, psePowerW: 90, pdPowerW: 71.3, pdMinVoltageV: 41.1, pairs: 4 },
};

const COPPER_TEMP_COEFFICIENT = 0.00393; // per degree C, around 20 C

// DC loop resistance of a channel in ohms. Each polarity uses `pairs / 2` pairs
// in parallel, i.e. pairs conductors in parallel across out and back.
export function loopResistanceOhm({ channelM, resistancePer100m, pairs, tempC = 20 }) {
  const perConductor = (resistancePer100m * channelM) / 100;
  const hot = perConductor * (1 + COPPER_TEMP_COEFFICIENT * (tempC - 20));
  // out: (pairs/2 pairs, 2 conductors each) in parallel; back: the same
  const conductorsEachWay = pairs; // pairs/2 pairs x 2 wires
  return (2 * hot) / conductorsEachWay;
}

// What the AP receives over a run.
//   pdPowerW     power the AP must receive (its draw)
//   pseVoltageV  voltage at the switch port
// The current solves  V_pse = V_pd + I R  with  P_pd = V_pd I.
export function poeLink({ pdPowerW, pseVoltageV, loopOhm, pdMinVoltageV, psePowerW }) {
  const discriminant = pseVoltageV ** 2 - 4 * loopOhm * pdPowerW;
  if (discriminant < 0)
    return {
      ok: false,
      reason: "the cable resistance is too high to deliver this power at all",
      currentA: null, pdVoltageV: null, cableLossW: null, psePowerNeededW: null,
    };
  const currentA = loopOhm === 0 ? pdPowerW / pseVoltageV : (pseVoltageV - Math.sqrt(discriminant)) / (2 * loopOhm);
  const pdVoltageV = pdPowerW / currentA;
  const cableLossW = currentA ** 2 * loopOhm;
  const psePowerNeededW = pdPowerW + cableLossW;
  const reasons = [];
  if (pdVoltageV < pdMinVoltageV)
    reasons.push(`the AP would receive ${pdVoltageV.toFixed(1)} V, below its ${pdMinVoltageV} V minimum`);
  if (psePowerNeededW > psePowerW)
    reasons.push(`the port would need ${psePowerNeededW.toFixed(1)} W, above the ${psePowerW} W it supplies`);
  return {
    ok: reasons.length === 0,
    reason: reasons.join("; "),
    currentA,
    pdVoltageV,
    cableLossW,
    psePowerNeededW,
  };
}
