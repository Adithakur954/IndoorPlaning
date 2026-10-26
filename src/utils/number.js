export const num = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
