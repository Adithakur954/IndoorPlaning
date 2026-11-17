use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{pkcs8::DecodePrivateKey, Signer, SigningKey};
use serde_json::json;
use std::{fs, path::Path};
use uuid::Uuid;
use zeroize::Zeroizing;

pub fn issue(private_file: &Path, machine_id: &str, days: u32) -> Result<String, String> {
    let machine_id = machine_id.trim().to_ascii_uppercase();
    let full = machine_id.len() == 67
        && machine_id.starts_with("IP-")
        && machine_id.as_bytes()[3..].iter().all(u8::is_ascii_hexdigit);
    // Short form shown in Indoor Planner, e.g. EC57-B4B2-339D-B17E.
    let short = machine_id.len() == 19
        && machine_id.split('-').count() == 4
        && machine_id
            .split('-')
            .all(|g| g.len() == 4 && g.bytes().all(|b| b.is_ascii_hexdigit()));
    if !full && !short {
        return Err("Paste the machine ID shown in Indoor Planner (for example EC57-B4B2-339D-B17E).".into());
    }
    if !(1..=36500).contains(&days) {
        return Err("Validity must be between 1 and 36500 days.".into());
    }
    if fs::metadata(private_file)
        .map_err(|_| "Select your existing private.pem signing key.")?
        .len()
        > 65536
    {
        return Err("The selected file is too large to be a private signing key.".into());
    }
    let pem = Zeroizing::new(
        fs::read_to_string(private_file).map_err(|_| "Could not read the private signing key.")?,
    );
    let key = SigningKey::from_pkcs8_pem(&pem)
        .map_err(|_| "Use the unencrypted Ed25519 private.pem created for this application.")?;
    let public_file = private_file.with_file_name("public.key");
    if public_file.exists() {
        let public = fs::read_to_string(public_file)
            .map_err(|_| "Could not read the matching public.key.")?;
        if public.trim() != URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes()) {
            return Err("This private key does not match public.key in the same folder.".into());
        }
    }
    let payload = json!({
        "product": "indoor-planner", "version": 2,
        "licenseId": Uuid::new_v4().to_string(),
        "machineIdHash": machine_id, "durationDays": days,
    });
    let message = format!(
        "IP2.{}",
        URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&payload).map_err(|_| "Could not create license contents.")?
        )
    );
    let signature = key.sign(message.as_bytes());
    Ok(format!(
        "{message}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_short_ids_and_out_of_range_duration_before_loading_a_key() {
        assert!(issue(Path::new("missing.pem"), "EC57-B4B2", 5)
            .unwrap_err()
            .contains("machine ID"));
        assert!(issue(Path::new("missing.pem"), "EC57-B4B2-339D-B17E", 0)
            .unwrap_err()
            .contains("Validity"));
        let id = format!("IP-{}", "A".repeat(64));
        assert!(issue(Path::new("missing.pem"), &id, 0)
            .unwrap_err()
            .contains("Validity"));
        assert!(issue(Path::new("missing.pem"), &id, 36501)
            .unwrap_err()
            .contains("Validity"));
    }
}
