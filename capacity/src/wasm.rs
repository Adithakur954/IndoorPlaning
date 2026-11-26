//! WebAssembly exports. JavaScript writes the JSON request into memory from
//! `cap_alloc`, calls `cap_call`, reads `cap_result_len` bytes from
//! `cap_result_ptr`, then frees the request with `cap_free`.

use std::cell::RefCell;

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn cap_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` must come from one `cap_alloc` call.
#[no_mangle]
pub unsafe extern "C" fn cap_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn cap_call(ptr: *const u8, len: usize) -> usize {
    let input = std::slice::from_raw_parts(ptr, len);
    let out = crate::handle_json(input);
    RESULT.with(|r| {
        *r.borrow_mut() = out;
        r.borrow().len()
    })
}

#[no_mangle]
pub extern "C" fn cap_result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn cap_result_len() -> usize {
    RESULT.with(|r| r.borrow().len())
}
