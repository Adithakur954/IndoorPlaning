# Standalone Windows license generator

Open `build/license-generator/IndoorPlanner-LicenseGenerator.exe`. This is a
portable Windows x64 program: it does not require Node.js, Python, WebView2, an
installer, or an internet connection.

1. Select your existing `licensing-private/private.pem` using **Browse**. The
   generator finds it automatically when launched from the project's build folder
   or when `private.pem` is beside the EXE.
2. Paste the customer's complete machine ID using the copy button in Indoor
   Planner. The compact on-screen ID alone is insufficient.
3. Enter the allowed number of days, from 1 to 36500.
4. Click **Generate license key**, then **Copy key** or **Save .license file**.
5. Send only the generated key/file to the customer. They paste it into the app
   and click **Activate**.

The generated key uses the existing `IP2` signature format. Days start on first
activation and expire using the customer's computer date/time. Changing the
machine ID, duration, or selected signing-key path clears the previous result.
If `public.key` is beside the selected private key, the generator checks that
the pair matches before signing.

The EXE does not embed your private key or generate replacement publisher keys.
Keep `private.pem` securely backed up on your own system. If you move the EXE,
use Browse to select that same private key; it must match the public key bundled
with customer installations.

To rebuild or verify the generator from source:

```powershell
npm.cmd run license:generator:build
npm.cmd run license:generator:check
```

The build compiles only this utility, statically links its C runtime, and writes
the EXE plus a SHA-256 checksum under `build/license-generator`. It does not
rebuild the customer application or its installer. The check exercises a hidden
native window with disposable keys, verifies the resulting signature using the
application's verifier, and checks activation and expiry without changing the
computer clock or real customer records.
