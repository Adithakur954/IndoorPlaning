# Offline machine-ID licensing

Version 1.0.4 uses signed offline licenses and the computer's local date/time.
No licensing server, internet connection, or external time service is required.

The app hashes the Windows MachineGuid into the displayed machine ID. The raw
system ID stays on the computer. The publisher signs a license containing that
hash and an allowed number of days with an Ed25519 private key. Node and Rust
verify the signature using the public key and reject keys for other machines.

## Publisher keys

The publisher key pair is stored in `licensing-private/private.pem` and
`licensing-private/public.key`. These files are ignored by Git. Only the public
key is included in customer builds; keep the private key securely backed up and
do not send it with the installer.

For a new publisher identity, create the keys once:

```powershell
npm.cmd run license:admin -- init --dir licensing-private
```

The command refuses to overwrite keys. Reuse this pair for subsequent builds so
existing signed licenses keep working. The desktop build uses this public key by
default; set `DESKTOP_LICENSE_PUBLIC_KEY_FILE` to use another public-key file.

## Issue a customer key

You can use the standalone Windows EXE with **Browse**, **Generate**, **Copy**,
and **Save** controls. See [License generator](LICENSE_GENERATOR.md). The command
line method below remains available.

The app displays a compact ID such as `EC57-B4B2-339D-B17E`, with an inline copy
button. Use that button to copy the complete device hash for key generation;
the compact display preserves compatibility with existing signed licenses.
Then run:

```powershell
npm.cmd run license:admin -- issue --private licensing-private/private.pem --machine-id "PASTE_HASHED_MACHINE_ID" --days 30 --out customer.license
```

Send the contents of `customer.license` to the customer. They paste it into the
activation screen. The number of days is signed and cannot be edited without
invalidating the key. Issue a new key to renew; each new key starts its own
duration when activated.

## Expiry behavior

The first successful activation stores its local timestamp in `licenses.sqlite`
inside the app's data directory. Expiry is that timestamp plus the signed number
of 24-hour days. Calendar time continues passing while the app is closed.
Reopening the app or re-entering the same key does not restart the recorded
activation period. Activation history and the active key are committed together
in a SQLite transaction.

Every protected backend operation checks expiry against the current computer
clock. The UI also checks regularly and on window focus. A date before activation
is rejected with a clock message. An expired license blocks access without
deleting project data. A bad or wrong-machine key does not replace the current
working license.

Local clock changes can affect expiration. Deleting/editing the license database
or restoring old local backups can also reset or change activation records.
These are limitations of this offline policy; there is no trusted server clock,
remote revocation, or guarantee against deliberate client modification.

## Storage and development

The installed app uses `%LOCALAPPDATA%/com.indoorplanner.desktop/licenses.sqlite`.
It is separate from `projects.sqlite`. Preserve both databases when backing up
application data. Old online `activation.json` credentials are not used by this
offline protocol; offline keys have the `IP2` token prefix.

For source runs, set `LICENSE_PUBLIC_KEY_FILE` to the public-key path for Node and
the Rust debug service. Release Rust embeds `INDOOR_LICENSE_PUBLIC_KEY` at build
time; the desktop build supplies it automatically. `npm run dev` also requires a
valid license and defaults to `licensing-private/public.key`. Development and the
installed application keep their activation records in their respective data
directories, so a development instance may need activation separately. Restart
the development server after updating these settings. Only automated test
fixtures may bypass the Node API license gate.

```powershell
cargo build --manifest-path service/Cargo.toml
npm.cmd run license:check
```

The integration check uses temporary keys and data to verify offline activation,
machine binding, Node/Rust signature checks, and local-date expiry. It does not
change the computer clock or activate a customer's real installation.

See [Windows installer](WINDOWS_INSTALLER.md) for building and distribution.
