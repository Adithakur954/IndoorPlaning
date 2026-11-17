import { formatMachineId } from "../utils/licenseDisplay.js";
import React, { useCallback, useEffect, useRef, useState } from "react";

const allowed = (status) => status?.status === "active";
export default function ActivationGate({ children }) {
  const [license, setLicense] = useState(null);
  const [opened, setOpened] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const sequence = useRef(0);
  const activating = useRef(false);
  const update = useCallback((result) => {
    setLicense(result);
    if (allowed(result)) setOpened(true);
  }, []);
  const check = useCallback(async () => {
    if (activating.current) return;
    const version = ++sequence.current;
    try {
      const response = await fetch("/api/license/status", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Cannot check activation");
      const result = await response.json();
      if (version === sequence.current) update(result);
    } catch {
      if (version === sequence.current)
        setLicense((previous) => ({
          ...previous,
          status: "unavailable",
          message:
            "Cannot reach the local application service. Try reopening the app.",
        }));
    }
  }, [update]);
  useEffect(() => {
    check();
    const timer = setInterval(check, 60000);
    window.addEventListener("focus", check);
    window.addEventListener("license-required", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("license-required", check);
    };
  }, [check]);
  async function activate(event) {
    event.preventDefault();
    activating.current = true;
    const version = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error || `License ${result.status || "rejected"}`,
        );
      if (version === sequence.current) {
        update(result);
        setKey("");
      }
    } catch (failure) {
      setError(failure.message);
    } finally {
      activating.current = false;
      setBusy(false);
    }
  }
  const unlocked = allowed(license);
  async function copyMachineId() {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(formatMachineId(license.machineId));
      setCopied(true);
    } catch {
      setError(
        "Could not copy the machine ID. Try again in a browser that allows clipboard access.",
      );
    }
  }
  return (
    <>
      {opened && (
        <div hidden={!unlocked} style={{ height: "100%" }}>
          {children}
        </div>
      )}
      {!unlocked && (
        <main className="activation-screen">
          <section
            className="activation-card"
            aria-labelledby="activation-title"
          >
            <h1 id="activation-title">Activate Indoor Planner</h1>
            {!license ? (
              <p role="status">Checking your license…</p>
            ) : (
              <>
                <p>
                  Send this machine ID to your license provider to receive an
                  activation key.
                </p>
                <label htmlFor="machine-id">Machine ID</label>
                <div className="machine-id-field">
                  <input
                    id="machine-id"
                    readOnly
                    value={formatMachineId(license.machineId)}
                    title={license.machineId || "Machine ID unavailable"}
                  />
                  <button
                    type="button"
                    className="machine-id-copy"
                    disabled={!license.machineId}
                    onClick={copyMachineId}
                    title={
                      copied
                        ? "Copied"
                        : "Copy machine ID for license generation"
                    }
                    aria-label={
                      copied ? "Machine ID copied" : "Copy machine ID"
                    }
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      aria-hidden="true"
                    >
                      {copied ? (
                        <path
                          d="m5 12 4 4L19 6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      ) : (
                        <>
                          <rect x="8" y="8" width="12" height="13" rx="2" />
                          <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" />
                        </>
                      )}
                    </svg>
                  </button>
                </div>
                {license.status === "expired" && (
                  <p role="alert">
                    Your license has expired. Contact your provider for a
                    renewal key.
                  </p>
                )}
                {license.status === "clock_invalid" && (
                  <p role="alert">
                    The computer's date is earlier than the activation date.
                    Correct the date to continue.
                  </p>
                )}
                {license.message && <p role="status">{license.message}</p>}
                <form onSubmit={activate}>
                  <label htmlFor="activation-key">Activation key</label>
                  <textarea
                    id="activation-key"
                    rows={5}
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    required
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <p>
                    Activation works offline. Your license expires after the
                    allowed number of days from first activation, using this
                    computer's date and time.
                  </p>
                  <button type="submit" disabled={busy || !key.trim()}>
                    {busy ? "Activating…" : "Activate"}
                  </button>
                  <button type="button" disabled={busy} onClick={check}>
                    Check again
                  </button>
                </form>
                {opened && (
                  <p>
                    Your current workspace is kept open while verification is
                    unavailable. Saved projects remain on this computer.
                  </p>
                )}
                {error && <p role="alert">{error}</p>}
              </>
            )}
          </section>
        </main>
      )}
    </>
  );
}
