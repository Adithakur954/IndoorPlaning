// Short labels belong to one floor's canvas. The project keeps the imported
// equipment names and IDs for wiring, reports and the building schematic.
const importedName = /^(?:\d+F|GF|BF|TR)-(A|SP|CP)(\d+)$/i;
const importedShaft = /^(?:\d+F|GF|BF|TR)\s+S\d+\s+(Shaft\s+[A-Z]+)(?:\s+·\s+\d+)?$/i;

export function floorSourceLabels(sources) {
  const labels = new Map();
  const used = new Set();
  const imported = [];
  for (const source of sources) {
    const name = String(source.name ?? "").replace(/^AP-detected-(\d+)$/, "AP$1");
    const match = source.kind === "cellular" || source.kind === "das" ? importedName.exec(name) : null;
    const shaft = source.dasType === "riser" ? importedShaft.exec(name) : null;
    if (match || shaft) {
      imported.push({ source, name, match, shaft });
    } else {
      labels.set(source.id, name);
      used.add(name.toUpperCase());
    }
  }
  const nextNumber = { SP: 1, CP: 1 };
  imported.sort((a, b) =>
    Number(a.match?.[2] || 0) - Number(b.match?.[2] || 0) || a.name.localeCompare(b.name),
  );
  for (const { source, match, shaft } of imported) {
    const prefix = match?.[1].toUpperCase();
    let label;
    if (prefix === "SP" || prefix === "CP") {
      do label = `${prefix}${nextNumber[prefix]++}`;
      while (used.has(label));
    } else {
      const base = shaft?.[1] ?? `A${Number(match[2])}`;
      label = base;
      for (let suffix = 2; used.has(label.toUpperCase()); suffix++) label = `${base} (${suffix})`;
    }
    labels.set(source.id, label);
    used.add(label.toUpperCase());
  }
  return labels;
}
