// A compact display only. Keep the full device hash for signing and verification.
export function formatMachineId(machineId) {
  if (!/^IP-[A-F0-9]{64}$/.test(machineId || ""))
    return "Machine ID unavailable";
  return machineId.slice(3, 19).match(/.{4}/g).join("-");
}
