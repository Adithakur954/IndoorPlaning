import React, { useCallback, useEffect, useRef, useState } from "react";
import { formatMachineId } from "../utils/licenseDisplay.js";

// Header badge: shows the license state; click to update or remove the key.
export default function LicenseBadge() {
  const [license, setLicense] = useState(null);
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = useRef(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/license/status", { cache: "no-store" });
      if (response.ok) setLicense(await response.json());
    } catch {
      /* the activation gate reports connection problems */
    }
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 60000);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [load]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // The gate re-checks on this event and locks or unlocks the app.
  const notifyGate = () => window.dispatchEvent(new Event("license-required"));

  async function request(url, options, failure) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, options);
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || result.message || failure);
      setLicense(result);
      return true;
    } catch (problem) {
      setError(problem.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function update(event) {
    event.preventDefault();
    const ok = await request(
      "/api/license/activate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      },
      "The key was rejected",
    );
    if (ok) {
      setKey("");
      setOpen(false);
      notifyGate();
    }
  }
  async function remove() {
    if (
      !window.confirm(
        "Remove the current license key? The app will lock until a valid key is entered. Your projects are not deleted.",
      )
    )
      return;
    const ok = await request(
      "/api/license",
      { method: "DELETE" },
      "Could not remove the license key",
    );
    if (ok) {
      setOpen(false);
      notifyGate();
    }
  }

  const active = license?.status === "active";
  const label = !license
    ? "License…"
    : active
      ? "License active"
      : license.status === "development"
        ? "License: development"
        : "License inactive";
  return (
    <div className="license-badge" ref={root}>
      <button
        type="button"
        className={`license-badge-button ${active ? "ok" : "bad"}`}
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setError("");
          load();
        }}
      >
        <span className="license-badge-dot" aria-hidden="true" />
        {label}
      </button>
      {open && (
        <section className="license-badge-panel" aria-label="License">
          {license?.machineId && (
            <p>
              <strong>Machine ID:</strong> {formatMachineId(license.machineId)}
            </p>
          )}
          {active && (
            <p>
              Expires {new Date(license.expiresAt).toLocaleDateString()} (
              {Math.ceil(license.remainingSeconds / 86400)} days left)
            </p>
          )}
          <form onSubmit={update}>
            <label htmlFor="license-badge-key">Update license key</label>
            <textarea
              id="license-badge-key"
              rows={4}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="license-badge-actions">
              <button type="submit" disabled={busy || !key.trim()}>
                {busy ? "Working…" : "Update key"}
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy || !active}
                onClick={remove}
              >
                Delete key
              </button>
            </div>
          </form>
          {error && <p role="alert">{error}</p>}
        </section>
      )}
    </div>
  );
}
