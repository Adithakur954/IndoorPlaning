fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let icon =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src-tauri/icons/icon.ico");
        tauri_winres::WindowsResource::new()
            .set_icon_with_id(icon.to_str().expect("icon path"), "1")
            .set("ProductName", "Indoor Planner License Generator")
            .set("FileDescription", "Offline publisher license generator")
            .set_manifest(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" processorArchitecture="*" name="IndoorPlanner.LicenseGenerator" type="win32"/>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo>
  <dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency>
</assembly>"#)
            .compile().expect("compile Windows icon and manifest");
    }
    println!("cargo:rerun-if-changed=../src-tauri/icons/icon.ico");
}
