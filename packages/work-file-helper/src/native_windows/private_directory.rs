//! Private snapshot creation uses the original token's user SID and a protected
//! DACL. This module does not mutate a live project or installed asset DACL.
use std::{ffi::c_void, fs::File, io, mem::size_of, os::windows::io::AsRawHandle, ptr};
use windows_sys::Win32::{Foundation::{CloseHandle, LocalFree, HANDLE}, Security::{DACL_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER, TokenUser, GetTokenInformation,
    GetSecurityDescriptorControl, EqualSid, GetAce, ACCESS_ALLOWED_ACE, ACL_SIZE_INFORMATION, AclSizeInformation,
    GetAclInformation, Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetSecurityInfo, SE_FILE_OBJECT, SDDL_REVISION_1}}, System::Threading::{OpenProcessToken, GetCurrentProcess}};

pub struct Descriptor(*mut c_void);
impl Drop for Descriptor { fn drop(&mut self) { unsafe { LocalFree(self.0); } } }
impl Descriptor {
    pub fn pointer(&self) -> *const c_void { self.0 }
    pub fn current_user() -> io::Result<Self> { Self::for_output(false,true) }
    pub(crate) fn command_input() -> io::Result<Self> { Self::for_output(false,false) }
    /// Only a precreated command output is writable by a low-integrity payload.
    /// Its protected user/SYSTEM DACL is unchanged; settings and inputs retain
    /// their normal integrity label.
    pub(crate) fn command_output() -> io::Result<Self> { Self::for_output(true,false) }
    fn for_output(low: bool, inherit: bool) -> io::Result<Self> {
        let user = current_user()?;
        let mut text = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid, &mut text) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut length = 0;
        while unsafe { *text.add(length) } != 0 && length < 256 { length += 1; }
        let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).map_err(|_| io::ErrorKind::InvalidData);
        unsafe { LocalFree(text.cast()); }
        let sid = sid?;
        // A file has no children. Windows strips OI/CI from its ACL during a
        // later publication; capture the exact non-inheriting file DACL first.
        let flags=if inherit{"OICI"}else{""};
        let value = format!("O:{sid}D:P(A;{flags};FA;;;{sid})(A;{flags};FA;;;SY){}", if low { "S:(ML;;NW;;;LW)" } else { "" }).encode_utf16().chain([0]).collect::<Vec<_>>();
        let mut descriptor = ptr::null_mut();
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(value.as_ptr(), SDDL_REVISION_1, &mut descriptor, ptr::null_mut()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(descriptor))
    }
}

pub fn require_private(file: &File) -> io::Result<()> {
    let user = current_user()?;
    let mut owner = ptr::null_mut();
    let mut dacl = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    if unsafe { GetSecurityInfo(file.as_raw_handle() as HANDLE, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &mut owner, ptr::null_mut(), &mut dacl, ptr::null_mut(), &mut descriptor) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let descriptor = Descriptor(descriptor);
    let mut control = 0;
    let mut revision = 0;
    if dacl.is_null() || unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0 ||
        control & SE_DACL_PROTECTED == 0 || unsafe { EqualSid(owner, (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid) } == 0 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut information: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetAclInformation(dacl, (&raw mut information).cast(), size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation) } == 0 ||
        information.AceCount == 0 || information.AceCount > 8 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    for index in 0..information.AceCount {
        let mut ace = ptr::null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() { return Err(io::ErrorKind::PermissionDenied.into()); }
        let ace = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        if ace.Header.AceType != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
        let sid = (&raw const ace.SidStart).cast_mut().cast();
        let mut sid_text = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut sid_text) } == 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
        let mut length = 0;
        while unsafe { *sid_text.add(length) } != 0 && length < 256 { length += 1; }
        let system = unsafe { std::slice::from_raw_parts(sid_text, length) } == "S-1-5-18".encode_utf16().collect::<Vec<_>>();
        unsafe { LocalFree(sid_text.cast()); }
        if !system && unsafe { EqualSid(sid, (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid) } == 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    Ok(())
}

fn current_user() -> io::Result<Vec<usize>> {
    let mut token = 0;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 { return Err(io::Error::last_os_error()); }
    let result = (|| {
        let mut bytes = 0;
        unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut bytes); }
        if bytes == 0 || bytes > 65_536 { return Err(io::ErrorKind::InvalidData.into()); }
        let mut buffer = vec![0usize; (bytes as usize + size_of::<usize>() - 1) / size_of::<usize>()];
        if unsafe { GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), bytes, &mut bytes) } == 0 { return Err(io::Error::last_os_error()); }
        Ok(buffer)
    })();
    unsafe { CloseHandle(token); }
    result
}
