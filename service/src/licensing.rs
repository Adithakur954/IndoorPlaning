//! Offline machine-bound licensing. Expiry uses the local computer date/time.
use crate::jobs::Shared;
use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};

fn verify(token: &str, prefix: &str, key: &VerifyingKey) -> Result<Value, String> {
    if token.len() > 16000 {
        return Err("license token too large".into());
    }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 || parts[0] != prefix {
        return Err("invalid license token".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|e| e.to_string())?;
    let signature = Signature::from_slice(&bytes).map_err(|e| e.to_string())?;
    key.verify_strict(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(parts[1])
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

async fn machine_id_hash() -> Result<String, String> {
    let identity: String;
    #[cfg(windows)]
    {
        let output = tokio::process::Command::new("reg.exe")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Cryptography",
                "/v",
                "MachineGuid",
                "/reg:64",
            ])
            .creation_flags(0x08000000)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&output.stdout);
        identity = text
            .lines()
            .find_map(|line| {
                line.split_once("REG_SZ")
                    .map(|(_, value)| value.trim().to_string())
            })
            .ok_or("cannot read machine identity")?;
    }
    #[cfg(target_os = "linux")]
    {
        identity = tokio::fs::read_to_string("/etc/machine-id")
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        let output = tokio::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&output.stdout);
        identity = text
            .lines()
            .find(|line| line.contains("\"IOPlatformUUID\""))
            .and_then(|line| line.split('=').nth(1))
            .map(|v| v.trim().trim_matches('"').to_string())
            .ok_or("cannot read machine identity")?;
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        return Err("unsupported machine identity platform".into());
    }
    if identity.trim().is_empty() {
        return Err("empty machine identity".into());
    }
    Ok(format!(
        "IP-{}",
        hex::encode(Sha256::digest(
            format!("IndoorPlanner:v1:{}", identity.trim().to_lowercase()).as_bytes()
        ))
        .to_uppercase()
    ))
}

fn machine_matches(grant_id: &str, machine: &str) -> bool {
    if grant_id == machine {
        return true;
    }
    // Short form: first 16 hex characters of the full hash, in groups of four.
    machine.len() >= 19
        && machine.starts_with("IP-")
        && machine.is_char_boundary(19)
        && grant_id
            == machine[3..19]
                .as_bytes()
                .chunks(4)
                .map(|c| std::str::from_utf8(c).unwrap_or(""))
                .collect::<Vec<_>>()
                .join("-")
}

fn validate_local_license(
    grant: &Value,
    license_id: &str,
    machine: &str,
    activated_at: i64,
    current_time: i64,
) -> Result<(), String> {
    let days = grant["durationDays"]
        .as_i64()
        .filter(|n| (1..=36500).contains(n))
        .ok_or("invalid license duration")?;
    if grant["product"] != "indoor-planner"
        || grant["version"] != 2
        || grant["licenseId"] != license_id
        || !machine_matches(grant["machineIdHash"].as_str().unwrap_or(""), machine)
        || activated_at < 0
    {
        return Err("license does not match this machine or activation record".into());
    }
    let expires_at = activated_at
        .checked_add(days * 86400000)
        .ok_or("invalid expiry")?;
    if current_time < activated_at {
        return Err("computer date is earlier than activation".into());
    }
    if current_time >= expires_at {
        return Err("license has expired".into());
    }
    Ok(())
}

async fn check(projects_file: &Path) -> Result<(), String> {
    // The release public key is pinned; no server or Internet request is used.
    let raw = if cfg!(debug_assertions) {
        tokio::fs::read_to_string(
            std::env::var("LICENSE_PUBLIC_KEY_FILE")
                .map_err(|_| "license public key is not configured")?,
        )
        .await
        .map_err(|e| e.to_string())?
    } else {
        option_env!("INDOOR_LICENSE_PUBLIC_KEY")
            .ok_or("release license public key was not pinned")?
            .to_string()
    };
    let bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(raw.trim())
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "invalid public key")?;
    let public_key = VerifyingKey::from_bytes(&bytes).map_err(|e| e.to_string())?;
    let database_file = projects_file
        .parent()
        .ok_or("invalid data directory")?
        .join("licenses.sqlite");
    let db = rusqlite::Connection::open_with_flags(
        database_file,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "offline activation is required")?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let (token, license_id, activated_at): (String, String, i64) = db.query_row(
        "SELECT a.license_key, a.license_id, a.activated_at FROM license_selection s JOIN license_activations a ON a.license_id = s.license_id WHERE s.id = 1",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| "offline activation is required")?;
    let grant = verify(&token, "IP2", &public_key)?;
    static MACHINE: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    let machine = MACHINE.get_or_try_init(machine_id_hash).await?;
    let current_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "invalid computer date")?
        .as_millis()
        .try_into()
        .map_err(|_| "invalid computer date")?;
    validate_local_license(&grant, &license_id, machine, activated_at, current_time)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn offline_expiry_uses_computer_time_and_checks_machine_and_record() {
        let grant = json!({"product": "indoor-planner", "version": 2, "licenseId": "id", "machineIdHash": "machine", "durationDays": 30});
        assert!(validate_local_license(&grant, "id", "machine", 1000, 1000).is_ok());
        assert!(
            validate_local_license(&grant, "id", "machine", 1000, 1000 + 30 * 86400000 - 1).is_ok()
        );
        assert!(
            validate_local_license(&grant, "id", "machine", 1000, 1000 + 30 * 86400000).is_err()
        );
        assert!(validate_local_license(&grant, "id", "machine", 1000, 999).is_err());
        assert!(validate_local_license(&grant, "other", "machine", 1000, 1000).is_err());
        assert!(validate_local_license(&grant, "id", "other", 1000, 1000).is_err());
        let full = format!("IP-EC57B4B2339DB17E{}", "0".repeat(48));
        assert!(machine_matches("EC57-B4B2-339D-B17E", &full));
        assert!(machine_matches(&full, &full));
        assert!(!machine_matches("EC57-B4B2-339D-B17F", &full));
    }

    #[test]
    fn verifies_signatures_and_rejects_tampering_or_wrong_token_type() {
        // Test-only seed; never used to issue application licenses.
        let signing = SigningKey::from_bytes(&[42; 32]);
        let payload = URL_SAFE_NO_PAD.encode(br#"{"status":"active","product":"indoor-planner"}"#);
        let message = format!("IPS1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing.sign(message.as_bytes()).to_bytes());
        let token = format!("{message}.{signature}");
        assert_eq!(
            verify(&token, "IPS1", &signing.verifying_key()).unwrap()["status"],
            "active"
        );
        assert!(verify(&token, "IP1", &signing.verifying_key()).is_err());
        let tampered = format!(
            "IPS1.{}.{}",
            URL_SAFE_NO_PAD.encode(br#"{"status":"active","changed":true}"#),
            signature
        );
        assert!(verify(&tampered, "IPS1", &signing.verifying_key()).is_err());
        assert!(verify(
            &token,
            "IPS1",
            &SigningKey::from_bytes(&[43; 32]).verifying_key()
        )
        .is_err());
    }
}

pub async fn require_license(
    State(state): State<Shared>,
    request: Request,
    next: Next,
) -> Response {
    if request.uri().path() == "/api/health" {
        return next.run(request).await;
    }
    // Explicit source-development switch. Never set this in a distributed build.
    if cfg!(debug_assertions)
        && std::env::var("INDOOR_LICENSE_MODE").as_deref() == Ok("development")
    {
        return next.run(request).await;
    }
    match check(&state.cfg.projects_file).await {
        Ok(()) => next.run(request).await,
        Err(_) => (StatusCode::PAYMENT_REQUIRED, Json(json!({ "code": "LICENSE_REQUIRED", "error": "An active offline license is required. Open the app to activate or check the computer date." }))).into_response(),
    }
}
