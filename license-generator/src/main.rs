#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod license;
use std::{
    fs, mem,
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::{DataExchange::*, LibraryLoader::GetModuleHandleW, Memory::*},
    UI::{
        Controls::{Dialogs::*, EM_SETLIMITTEXT},
        HiDpi::GetDpiForSystem,
        Input::KeyboardAndMouse::*,
        WindowsAndMessaging::*,
    },
};

const KEY: i32 = 101;
const BROWSE: i32 = 102;
const MACHINE: i32 = 103;
const DAYS: i32 = 104;
const GENERATE: i32 = 105;
const OUTPUT: i32 = 106;
const COPY: i32 = 107;
const SAVE: i32 = 108;
const STATUS: i32 = 109;
struct State {
    token: Option<String>,
    fonts: Vec<HFONT>,
    error: bool,
    default_key: PathBuf,
}
impl Drop for State {
    fn drop(&mut self) {
        for font in &self.fonts {
            unsafe {
                DeleteObject(*font);
            }
        }
    }
}
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
fn scale(value: i32) -> i32 {
    (value * unsafe { GetDpiForSystem() }.max(96) as i32 + 48) / 96
}
unsafe fn state(window: HWND) -> *mut State {
    GetWindowLongPtrW(window, GWLP_USERDATA) as *mut State
}
unsafe fn field(window: HWND, id: i32) -> String {
    let control = GetDlgItem(window, id);
    let mut value = vec![0u16; GetWindowTextLengthW(control).max(0) as usize + 1];
    let count = GetWindowTextW(control, value.as_mut_ptr(), value.len() as i32);
    String::from_utf16_lossy(&value[..count.max(0) as usize])
}
unsafe fn text(window: HWND, id: i32, value: &str) {
    let control = GetDlgItem(window, id);
    if !control.is_null() {
        SetWindowTextW(control, wide(value).as_ptr());
    }
}
unsafe fn status(window: HWND, value: &str, error: bool) {
    (*state(window)).error = error;
    text(window, STATUS, value);
    let control = GetDlgItem(window, STATUS);
    if !control.is_null() {
        InvalidateRect(control, ptr::null(), 1);
    }
}
unsafe fn clear_output(window: HWND) {
    (*state(window)).token = None;
    text(window, OUTPUT, "");
    EnableWindow(GetDlgItem(window, COPY), 0);
    EnableWindow(GetDlgItem(window, SAVE), 0);
    status(
        window,
        "Ready. Choose the signing key, paste a machine ID, and set the validity.",
        false,
    );
}
unsafe fn font(size: i32, weight: i32, face: &str) -> HFONT {
    CreateFontW(
        -scale(size),
        0,
        0,
        0,
        weight,
        0,
        0,
        0,
        DEFAULT_CHARSET as u32,
        OUT_DEFAULT_PRECIS as u32,
        CLIP_DEFAULT_PRECIS as u32,
        CLEARTYPE_QUALITY as u32,
        DEFAULT_PITCH as u32,
        wide(face).as_ptr(),
    )
}
unsafe fn control(
    window: HWND,
    class: &str,
    caption: &str,
    id: i32,
    style: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    font: HFONT,
) -> HWND {
    let handle = CreateWindowExW(
        if class == "EDIT" { WS_EX_CLIENTEDGE } else { 0 },
        wide(class).as_ptr(),
        wide(caption).as_ptr(),
        WS_CHILD | WS_VISIBLE | style,
        scale(x),
        scale(y),
        scale(width),
        scale(height),
        window,
        id as isize as HMENU,
        GetModuleHandleW(ptr::null()),
        ptr::null(),
    );
    SendMessageW(handle, WM_SETFONT, font as usize, 1);
    handle
}
unsafe fn create_ui(window: HWND) {
    let body = font(14, 400, "Segoe UI");
    let title = font(22, 600, "Segoe UI");
    let mono = font(13, 400, "Consolas");
    (*state(window)).fonts.extend([body, title, mono]);
    control(
        window,
        "STATIC",
        "Indoor Planner License Generator",
        0,
        0,
        24,
        18,
        690,
        32,
        title,
    );
    control(
        window,
        "STATIC",
        "Create offline activation keys for a customer's machine ID.",
        0,
        0,
        24,
        56,
        690,
        24,
        body,
    );
    control(
        window,
        "STATIC",
        "Publisher signing key (private.pem)",
        0,
        0,
        24,
        92,
        690,
        22,
        body,
    );
    let default_key = (*state(window)).default_key.to_string_lossy().into_owned();
    control(
        window,
        "EDIT",
        &default_key,
        KEY,
        ES_READONLY as u32 | ES_AUTOHSCROLL as u32,
        24,
        116,
        576,
        30,
        body,
    );
    control(
        window,
        "BUTTON",
        "Browse...",
        BROWSE,
        WS_TABSTOP,
        612,
        116,
        104,
        30,
        body,
    );
    control(
        window,
        "STATIC",
        "Machine ID - copy it from Indoor Planner (e.g. EC57-B4B2-339D-B17E)",
        0,
        0,
        24,
        160,
        692,
        22,
        body,
    );
    let machine = control(
        window,
        "EDIT",
        "",
        MACHINE,
        WS_TABSTOP | ES_AUTOHSCROLL as u32,
        24,
        184,
        692,
        32,
        mono,
    );
    SendMessageW(machine, EM_SETLIMITTEXT, 256, 0);
    control(
        window,
        "STATIC",
        "Validity (days)",
        0,
        0,
        24,
        230,
        160,
        22,
        body,
    );
    let days = control(
        window,
        "EDIT",
        "30",
        DAYS,
        WS_TABSTOP | ES_NUMBER as u32,
        24,
        254,
        140,
        32,
        body,
    );
    SendMessageW(days, EM_SETLIMITTEXT, 5, 0);
    control(
        window,
        "BUTTON",
        "Generate license key",
        GENERATE,
        WS_TABSTOP | BS_DEFPUSHBUTTON as u32,
        180,
        252,
        220,
        36,
        body,
    );
    control(
        window,
        "STATIC",
        "Generated activation key",
        0,
        0,
        24,
        306,
        692,
        22,
        body,
    );
    control(
        window,
        "EDIT",
        "",
        OUTPUT,
        WS_TABSTOP | WS_VSCROLL | ES_MULTILINE as u32 | ES_READONLY as u32 | ES_AUTOVSCROLL as u32,
        24,
        330,
        692,
        88,
        mono,
    );
    control(
        window, "BUTTON", "Copy key", COPY, WS_TABSTOP, 24, 432, 140, 34, body,
    );
    control(
        window,
        "BUTTON",
        "Save .license file...",
        SAVE,
        WS_TABSTOP,
        176,
        432,
        182,
        34,
        body,
    );
    control(window, "STATIC", "", STATUS, 0, 24, 480, 692, 42, body);
    clear_output(window);
}
unsafe fn choose_file(window: HWND, save: bool) -> Option<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    if save {
        let name = wide(&format!("customer-{}days.license", field(window, DAYS)));
        buffer[..name.len()].copy_from_slice(&name);
    }
    let filter = wide(if save {
        "License files (*.license)\0*.license\0All files\0*.*\0"
    } else {
        "Private signing key (*.pem)\0*.pem\0All files\0*.*\0"
    });
    let extension = wide("license");
    let title = wide(if save {
        "Save customer license"
    } else {
        "Choose publisher private.pem"
    });
    let mut dialog: OPENFILENAMEW = mem::zeroed();
    dialog.lStructSize = mem::size_of::<OPENFILENAMEW>() as u32;
    dialog.hwndOwner = window;
    dialog.lpstrFilter = filter.as_ptr();
    dialog.lpstrFile = buffer.as_mut_ptr();
    dialog.nMaxFile = buffer.len() as u32;
    dialog.lpstrTitle = title.as_ptr();
    dialog.lpstrDefExt = if save {
        extension.as_ptr()
    } else {
        ptr::null()
    };
    dialog.Flags = OFN_EXPLORER
        | OFN_PATHMUSTEXIST
        | OFN_NOCHANGEDIR
        | OFN_DONTADDTORECENT
        | if save {
            OFN_OVERWRITEPROMPT
        } else {
            OFN_FILEMUSTEXIST
        };
    let selected = if save {
        GetSaveFileNameW(&mut dialog)
    } else {
        GetOpenFileNameW(&mut dialog)
    };
    if selected == 0 {
        return None;
    }
    let length = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..length])))
}
unsafe fn copy_key(window: HWND, value: &str) -> Result<(), String> {
    if OpenClipboard(window) == 0 {
        return Err("Clipboard is busy. Try Copy key again.".into());
    }
    let result = (|| {
        let data = wide(value);
        let memory = GlobalAlloc(GMEM_MOVEABLE, data.len() * 2);
        if memory.is_null() {
            return Err("Could not allocate clipboard memory.".into());
        }
        let target = GlobalLock(memory) as *mut u16;
        if target.is_null() {
            GlobalFree(memory);
            return Err("Could not open clipboard memory.".into());
        }
        ptr::copy_nonoverlapping(data.as_ptr(), target, data.len());
        GlobalUnlock(memory);
        if EmptyClipboard() == 0 || SetClipboardData(13, memory).is_null() {
            GlobalFree(memory);
            return Err("Could not copy the key. Try again.".into());
        }
        Ok(())
    })();
    CloseClipboard();
    result
}
unsafe fn generate(window: HWND) {
    let days = field(window, DAYS).trim().parse::<u32>().unwrap_or(0);
    match license::issue(
        Path::new(&field(window, KEY)),
        &field(window, MACHINE),
        days,
    ) {
        Ok(token) => {
            (*state(window)).token = Some(token.clone());
            text(window, OUTPUT, &token);
            EnableWindow(GetDlgItem(window, COPY), 1);
            EnableWindow(GetDlgItem(window, SAVE), 1);
            status(window, &format!("Generated a {days}-day key. Days start at first activation, using the customer's computer date."), false);
        }
        Err(error) => {
            clear_output(window);
            status(window, &error, true);
        }
    }
}
unsafe extern "system" fn window_proc(window: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(l as *const CREATESTRUCTW);
        SetWindowLongPtrW(window, GWLP_USERDATA, create.lpCreateParams as isize);
    }
    if state(window).is_null() {
        return DefWindowProcW(window, message, w, l);
    }
    match message {
        WM_CREATE => {
            create_ui(window);
            0
        }
        WM_COMMAND => {
            let id = (w & 0xffff) as i32;
            let event = ((w >> 16) & 0xffff) as u32;
            if event == EN_CHANGE && [KEY, MACHINE, DAYS].contains(&id) {
                clear_output(window);
            }
            if event == BN_CLICKED {
                match id {
                    BROWSE => {
                        if let Some(file) = choose_file(window, false) {
                            text(window, KEY, &file.to_string_lossy());
                        }
                    }
                    GENERATE => generate(window),
                    COPY => {
                        let token = (*state(window)).token.clone();
                        if let Some(token) = token {
                            match copy_key(window, &token) {
                                Ok(()) => status(
                                    window,
                                    "License key copied. Send only this key to the customer.",
                                    false,
                                ),
                                Err(error) => status(window, &error, true),
                            }
                        }
                    }
                    SAVE => {
                        let token = (*state(window)).token.clone();
                        if let Some(token) = token {
                            if let Some(file) = choose_file(window, true) {
                                match fs::write(file, token) {
                                    Ok(()) => status(window, "License file saved. Keep the private signing key on your own system.", false),
                                    Err(_) => status(window, "Could not save the file. Choose a writable folder.", true),
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            0
        }
        WM_CTLCOLORSTATIC | WM_CTLCOLOREDIT => {
            SetBkColor(w as HDC, 0x00ffffff);
            let is_error = GetDlgCtrlID(l as HWND) == STATUS && (*state(window)).error;
            SetTextColor(w as HDC, if is_error { 0x003030b0 } else { 0x00332719 });
            GetSysColorBrush(COLOR_WINDOW) as LRESULT
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(window, message, w, l),
    }
}
fn default_key() -> PathBuf {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let project_key = dir
        .parent()
        .and_then(Path::parent)
        .map(|root| root.join("licensing-private/private.pem"))
        .unwrap_or_default();
    let candidates = [
        dir.join("private.pem"),
        dir.join("licensing-private/private.pem"),
        project_key,
    ];
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or_default()
}
unsafe fn run_gui(test: Option<&[String]>) -> Result<(), String> {
    SetProcessDPIAware();
    let instance = GetModuleHandleW(ptr::null());
    let class_name = wide("IndoorPlannerLicenseGenerator");
    let icon = LoadIconW(instance, 1 as *const u16);
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance,
        lpszClassName: class_name.as_ptr(),
        hIcon: icon,
        hCursor: LoadCursorW(ptr::null_mut(), IDC_ARROW),
        hbrBackground: GetSysColorBrush(COLOR_WINDOW),
        ..mem::zeroed()
    };
    if RegisterClassW(&class) == 0 {
        return Err("Could not register the generator window.".into());
    }
    let mut model = Box::new(State {
        token: None,
        fonts: Vec::new(),
        error: false,
        default_key: default_key(),
    });
    let style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
    let mut bounds = RECT {
        left: 0,
        top: 0,
        right: scale(740),
        bottom: scale(540),
    };
    AdjustWindowRectEx(&mut bounds, style, 0, 0);
    let window = CreateWindowExW(
        WS_EX_CONTROLPARENT,
        class_name.as_ptr(),
        wide("Indoor Planner - License Generator").as_ptr(),
        style,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        bounds.right - bounds.left,
        bounds.bottom - bounds.top,
        ptr::null_mut(),
        ptr::null_mut(),
        instance,
        &mut *model as *mut State as *const _,
    );
    if window.is_null() {
        return Err("Could not create the generator window.".into());
    }
    if let Some(args) = test {
        text(window, KEY, &args[0]);
        text(window, MACHINE, &args[1]);
        text(window, DAYS, &args[2]);
        SendMessageW(window, WM_COMMAND, GENERATE as usize, 0);
        let result = (|| {
            let token = model.token.clone().ok_or_else(|| field(window, STATUS))?;
            if field(window, OUTPUT) != token
                || IsWindowEnabled(GetDlgItem(window, COPY)) == 0
                || IsWindowEnabled(GetDlgItem(window, SAVE)) == 0
            {
                return Err("Generated key controls were not updated.".into());
            }
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&args[3])
                .and_then(|mut file| std::io::Write::write_all(&mut file, token.as_bytes()))
                .map_err(|e| e.to_string())?;
            text(window, MACHINE, "incomplete");
            if model.token.is_some() || IsWindowEnabled(GetDlgItem(window, COPY)) != 0 {
                return Err("Input changes did not clear the previous key.".into());
            }
            Ok(())
        })();
        DestroyWindow(window);
        return result;
    }
    ShowWindow(window, SW_SHOW);
    UpdateWindow(window);
    SetFocus(GetDlgItem(window, MACHINE));
    let mut message: MSG = mem::zeroed();
    loop {
        let result = GetMessageW(&mut message, ptr::null_mut(), 0, 0);
        if result == -1 {
            return Err("The window message loop failed.".into());
        }
        if result == 0 {
            break;
        }
        if IsDialogMessageW(window, &message) == 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Ok(())
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let is_test = args.first().is_some_and(|arg| arg == "--ui-self-test");
    let result = if is_test && args.len() == 5 {
        unsafe { run_gui(Some(&args[1..])) }
    } else if args.is_empty() {
        unsafe { run_gui(None) }
    } else {
        Err("Usage: open the EXE, or --ui-self-test <private.pem> <machine-id> <days> <output.license>".into())
    };
    if let Err(error) = result {
        if is_test {
            eprintln!("{error}");
        } else {
            unsafe {
                MessageBoxW(
                    ptr::null_mut(),
                    wide(&error).as_ptr(),
                    wide("License Generator").as_ptr(),
                    MB_OK | MB_ICONERROR,
                );
            }
        }
        std::process::exit(1);
    }
}
