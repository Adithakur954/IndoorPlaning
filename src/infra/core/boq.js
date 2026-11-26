// Bill of quantities. Shared by every system type. Every line says how its
// quantity was worked out, so a number in a report can always be traced.

export class Boq {
  constructor() {
    this.lines = new Map();
  }

  // Adds to a line, creating it on first use. Lines are keyed by group + part.
  add({ group, partId, name, unit = "nos", qty, basis, source }) {
    if (!(qty >= 0) || !Number.isFinite(qty))
      throw new RangeError(`quantity for ${name} must be a number of zero or more`);
    if (qty === 0) return this;
    const key = `${group}|${partId}`;
    const line = this.lines.get(key);
    if (line) {
      line.qty += qty;
      if (basis) line.basis.push(basis);
    } else {
      this.lines.set(key, {
        group,
        partId,
        name,
        unit,
        qty,
        basis: basis ? [basis] : [],
        source: source ?? "",
      });
    }
    return this;
  }

  // Whole units for things bought in whole units; metres stay as measured.
  toLines() {
    return [...this.lines.values()].map((l) => ({
      ...l,
      qty: l.unit === "m" ? Math.round(l.qty * 100) / 100 : Math.ceil(l.qty - 1e-9),
      basis: l.basis.join("; "),
    }));
  }
}
