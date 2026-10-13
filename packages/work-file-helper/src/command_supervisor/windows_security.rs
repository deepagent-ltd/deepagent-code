//! A fresh no-network AppContainer plus a distinct NT-authority restricting SID. Grant only exact
//! opened closure objects; neither an existing profile nor broad package access
//! may substitute for this run's filesystem boundary.
use super::{common, protocol::{Isolation, Run}, windows_job::check};
use crate::no_follow;
use sha2::{Digest, Sha256};
use std::{ffi::c_void, fs::File, io::{self, Read}, mem::size_of, os::windows::{ffi::OsStrExt,
    io::{AsRawHandle, FromRawHandle, OwnedHandle}}, path::Path, ptr, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use windows_sys::Win32::{Foundation::{CloseHandle, HANDLE, LocalFree, PSID}, Security::{CreateRestrictedToken,
    DISABLE_MAX_PRIVILEGE, WRITE_RESTRICTED, GetSecurityDescriptorControl, GetTokenInformation, EqualSid, FreeSid, IsTokenRestricted, IsValidAcl,
    SE_DACL_PROTECTED, SID_AND_ATTRIBUTES, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY, TOKEN_IMPERSONATE, ImpersonateLoggedOnUser, RevertToSelf, TokenAppContainerSid,
    TokenCapabilities, TokenIsAppContainer, TokenRestrictedSids, TokenUser, TOKEN_APPCONTAINER_INFORMATION, TOKEN_GROUPS, TOKEN_USER,
    DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, UNPROTECTED_DACL_SECURITY_INFORMATION, SECURITY_CAPABILITIES,
    Authorization::{EXPLICIT_ACCESS_W, GRANT_ACCESS, GetSecurityInfo, SetEntriesInAclW, SetSecurityInfo, SE_FILE_OBJECT, ConvertStringSidToSidW,
        TRUSTEE_W, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN}, Isolation::{CreateAppContainerProfile, DeleteAppContainerProfile}},
    Storage::FileSystem::{CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING}, System::Threading::{GetCurrentProcess, OpenProcessToken}};

pub struct Handle(pub HANDLE);
impl Drop for Handle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
struct Profile { sid: PSID, name: Vec<u16>, stopped: Arc<AtomicBool>, retirement_attempted: bool }
impl Profile {
    fn retire(&mut self) -> io::Result<()> {
        if self.retirement_attempted || !self.stopped.load(Ordering::Acquire) { return Err(io::ErrorKind::PermissionDenied.into()); }
        self.retirement_attempted = true;
        if unsafe { DeleteAppContainerProfile(self.name.as_ptr()) } != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
        Ok(())
    }
}
impl Drop for Profile { fn drop(&mut self) {
    if !self.retirement_attempted && self.stopped.load(Ordering::Acquire) { let _ = self.retire(); }
    unsafe { FreeSid(self.sid); }
} }
struct Restriction(PSID);
impl Drop for Restriction { fn drop(&mut self) { unsafe { LocalFree(self.0); } } }
pub struct Security { pub token: Handle, pub capabilities: SECURITY_CAPABILITIES, profile: Profile, restriction: Restriction, leases: Vec<AclLease>, stopped: Arc<AtomicBool> }
struct AclLease { file: File, original: *mut c_void, dacl: *mut windows_sys::Win32::Security::ACL,
    owner: PSID, changed: bool, flags: u32, granted: Vec<u8>, writable: bool, named: std::path::PathBuf, stopped: Arc<AtomicBool>, retirement_attempted: bool }
impl AclLease {
    fn restore(&mut self) -> io::Result<()> {
        if !self.changed { return Ok(()); }
        if self.retirement_attempted || !self.stopped.load(Ordering::Acquire) { return Err(io::ErrorKind::PermissionDenied.into()); }
        self.retirement_attempted = true;
        let current = Descriptor::read(&self.file)?;
        // Do not restore a remembered ACL over an independently changed owner
        // or ACL. This is an optimistic held-handle readback, not Windows CAS.
        if unsafe { EqualSid(current.owner, self.owner) } == 0 || current.control & SE_DACL_PROTECTED == 0 ||
            acl_bytes(current.dacl,4)? != self.granted { return Err(io::ErrorKind::PermissionDenied.into()); }
        if unsafe { SetSecurityInfo(self.file.as_raw_handle() as HANDLE, SE_FILE_OBJECT,
            self.flags, ptr::null_mut(), ptr::null_mut(), self.dacl, ptr::null()) } != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let after = Descriptor::read(&self.file)?;
        let protected = self.flags & PROTECTED_DACL_SECURITY_INFORMATION != 0;
        if unsafe { EqualSid(after.owner, self.owner) } == 0 ||
            (after.control & SE_DACL_PROTECTED != 0) != protected || acl_bytes(after.dacl,2)? != acl_bytes(self.dacl,2)? {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.changed = false;
        Ok(())
    }
}
impl Drop for AclLease {
    fn drop(&mut self) {
        if !self.retirement_attempted && self.stopped.load(Ordering::Acquire) { let _ = self.restore(); }
        unsafe { LocalFree(self.original); }
    }
}
impl Drop for Security {
    fn drop(&mut self) {
        self.leases.clear();
    }
}

impl Security {
    pub fn create(run: &Run, prepared: &common::Prepared, stopped: Arc<AtomicBool>) -> io::Result<Self> {
        let Isolation::Windows { runtime_files, .. } = &run.isolation else { return Err(io::ErrorKind::Unsupported.into()); };
        let name = wide(&format!("DAC.Work.{}", &run.nonce[..32]));
        let mut sid = ptr::null_mut();
        let result = unsafe { CreateAppContainerProfile(name.as_ptr(), name.as_ptr(), name.as_ptr(), ptr::null(), 0, &mut sid) };
        // S_FALSE/existing profiles cannot carry permission or loopback history.
        if result != 0 || sid.is_null() { return Err(io::ErrorKind::PermissionDenied.into()); }
        let profile = Profile { sid, name, stopped: stopped.clone(), retirement_attempted: false };
        let creation = (|| {
            phase("namespace",exact_namespace(run, prepared))?;
            // AppContainer's own SID also owns its profile directory. Using it
            // as the additional restricting SID would permit writes outside the
            // approved snapshot. This distinct random NT-authority SID is granted only
            // to the exact closure objects and is never a network capability.
            let numbers = run.nonce.as_bytes().chunks_exact(8).take(4).map(|chunk|
                u32::from_str_radix(std::str::from_utf8(chunk).expect("validated nonce"), 16).expect("validated nonce").to_string()).collect::<Vec<_>>();
            let mut restricting_sid = ptr::null_mut();
            check(unsafe { ConvertStringSidToSidW(wide(format!("S-1-5-21-{}", numbers.join("-"))).as_ptr(), &mut restricting_sid) })?;
            let restriction = Restriction(restricting_sid);
            let mut original = 0;
            phase("source-token",check(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY, &mut original) }))?;
            let original = Handle(original);
            let restricting = SID_AND_ATTRIBUTES { Sid: restriction.0, Attributes: 0 };
            let mut token = 0;
            phase("restrict-token",check(unsafe { CreateRestrictedToken(original.0, DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED, 0, ptr::null(), 0, ptr::null(), 1, &restricting, &mut token) }))?;
            let token = Handle(token);
            if unsafe { IsTokenRestricted(token.0) } == 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
            let user = information(original.0, TokenUser)?;
            let owner = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
            let mut security = Self { token, capabilities: SECURITY_CAPABILITIES { AppContainerSid: sid,
                Capabilities: ptr::null_mut(), CapabilityCount: 0, Reserved: 0 }, profile, restriction, leases: Vec::new(), stopped };
            // Each ancestor allows traversal/listing only. Nothing grants create,
            // delete, WRITE_DAC, WRITE_OWNER, attributes, or inherited access.
            phase("grant-root",security.grant(&prepared.root.path, &prepared.root.file, owner, 0x0012_00a9, true, false))?;
            for relative in run.inputs.iter().map(|value| &value.relative).chain(run.outputs.iter()) {
                let mut path = prepared.root.path.clone();
                let parts = no_follow::relative(relative)?;
                for part in &parts[..parts.len() - 1] {
                    path.push(part);
                    let file = no_follow::open_root(&path)?;
                    phase("grant-directory",security.grant(&path, &file, owner, 0x0012_00a9, true, false))?;
                }
            }
            for input in &run.inputs {
                let mut file = no_follow::open_relative(&prepared.root.file, &no_follow::relative(&input.relative)?)?;
                if no_follow::identity(&file)? != input.identity || file.metadata()?.len() != input.bytes { return Err(io::ErrorKind::InvalidData.into()); }
                let mut hash = Sha256::new();
                if io::copy(&mut Read::by_ref(&mut file).take(input.bytes + 1), &mut hash)? != input.bytes || format!("{:x}", hash.finalize()) != input.sha256 {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                phase("grant-input",security.grant(&prepared.root.path.join(&input.relative), &file, owner, 0x0012_0089, true, false))?;
            }
            for relative in &run.outputs {
                let file = no_follow::open_relative(&prepared.root.file, &no_follow::relative(relative)?)?;
                if file.metadata()?.len() != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
                // Ordinary runtime file writes request generic data/EA/attribute
                // access. Only this precreated, declared output receives it;
                // DELETE, WRITE_DAC and WRITE_OWNER remain absent.
                phase("grant-output",security.grant(&prepared.root.path.join(relative), &file, owner, 0x0012_019f, true, true))?;
            }
            // The installed public Bun image has a stable ARAP read/execute
            // ACE before publication and original image capture. Its DACL and
            // System32 DLL DACLs are never modified by a payload run.
            let _ = runtime_files;
            prepared.root.current()?;
            Ok(security)
        })();
        creation
    }

    fn grant(&mut self, path: &Path, expected: &File, owner: PSID, access: u32, private: bool, writable: bool) -> io::Result<()> {
        // Repeated ancestors share one lease; restoring nested snapshots in the
        // wrong order must not leave this run's SID on an installed object.
        let expected_identity = no_follow::identity(expected)?;
        if self.leases.iter().any(|lease| no_follow::identity(&lease.file).is_ok_and(|identity| identity == expected_identity)) { return Ok(()); }
        let handle = unsafe { CreateFileW(wide(path).as_ptr(), 0x0006_0080 | 0x0010_0000,
            FILE_SHARE_READ | if writable { FILE_SHARE_WRITE } else { 0 }, ptr::null(), OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, 0) };
        if handle == 0 || handle == -1 { return Err(io::Error::last_os_error()); }
        let file = File::from(unsafe { OwnedHandle::from_raw_handle(handle as *mut c_void) });
        if no_follow::identity(&file)? != no_follow::identity(expected)? { eprintln!("WINDOWS_COMMAND_SECURITY_FAILURE stage=acl-file-id");return Err(io::ErrorKind::PermissionDenied.into()); }
        let mut actual_owner = ptr::null_mut();
        let mut dacl = ptr::null_mut();
        let mut descriptor = ptr::null_mut();
        if unsafe { GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut actual_owner, ptr::null_mut(), &mut dacl, ptr::null_mut(), &mut descriptor) } != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let named = no_follow::final_path(&file)?;
        let mut lease = AclLease { file, original: descriptor, dacl, owner: actual_owner, changed: false,
            flags: DACL_SECURITY_INFORMATION, granted: Vec::new(), writable, named, stopped: self.stopped.clone(), retirement_attempted: false };
        let mut control = 0;
        let mut revision = 0;
        check(unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) })?;
        lease.flags |= if control & SE_DACL_PROTECTED != 0 { PROTECTED_DACL_SECURITY_INFORMATION } else { UNPROTECTED_DACL_SECURITY_INFORMATION };
        if dacl.is_null() || (private && (unsafe { EqualSid(owner, actual_owner) } == 0 || control & SE_DACL_PROTECTED == 0)) {
            eprintln!("WINDOWS_COMMAND_SECURITY_FAILURE stage=acl-private owner_equal={} protected={} null_dacl={}",unsafe{EqualSid(owner,actual_owner)}!=0,control&SE_DACL_PROTECTED!=0,dacl.is_null());
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let _ = acl_bytes(dacl,2)?;
        let entry = |sid: PSID| EXPLICIT_ACCESS_W { grfAccessPermissions: access, grfAccessMode: GRANT_ACCESS, grfInheritance: 0,
            Trustee: TRUSTEE_W { pMultipleTrustee: ptr::null_mut(), MultipleTrusteeOperation: 0, TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN, ptstrName: sid.cast() } };
        let entries = [entry(self.restriction.0), entry(self.capabilities.AppContainerSid)];
        let mut changed = ptr::null_mut();
        let merge=unsafe { SetEntriesInAclW(2, entries.as_ptr(), dacl, &mut changed) };
        if merge!=0{eprintln!("WINDOWS_COMMAND_SECURITY_FAILURE stage=acl-merge code={merge}");return Err(io::Error::from_raw_os_error(merge as i32));}
        let granted = acl_bytes(changed,4);
        if let Err(error) = granted { unsafe { LocalFree(changed.cast()); } return Err(error); }
        lease.granted = granted?;
        let result = unsafe { SetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(), ptr::null_mut(), changed, ptr::null()) };
        unsafe { LocalFree(changed.cast()); }
        if result != 0 { eprintln!("WINDOWS_COMMAND_SECURITY_FAILURE stage=acl-set code={result}");return Err(io::Error::from_raw_os_error(result as i32)); }
        lease.changed = true;
        self.leases.push(lease);
        let actual = Descriptor::read(&self.leases.last().ok_or(io::ErrorKind::InvalidData)?.file)?;
        if unsafe { EqualSid(owner, actual.owner) } == 0 || actual.control & SE_DACL_PROTECTED == 0 ||
            acl_bytes(actual.dacl,4)? != self.leases.last().ok_or(io::ErrorKind::InvalidData)?.granted {
            eprintln!("WINDOWS_COMMAND_SECURITY_FAILURE stage=acl-readback owner_equal={} protected={} granted_equal={}",unsafe{EqualSid(owner,actual.owner)}!=0,actual.control&SE_DACL_PROTECTED!=0,acl_bytes(actual.dacl,4)?==self.leases.last().ok_or(io::ErrorKind::InvalidData)?.granted);
            eprintln!("WINDOWS_COMMAND_SECURITY_FAILURE stage=acl-shape expected={} actual={}",
                acl_shape(&self.leases.last().ok_or(io::ErrorKind::InvalidData)?.granted),acl_shape(&acl_bytes(actual.dacl,4)?));
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(())
    }

    pub fn output_bytes(&self) -> io::Result<u64> {
        self.leases.iter().filter(|lease|lease.writable).try_fold(0u64,|maximum,lease|{
            // The original grant handle already allows metadata observation and
            // shares only the declared writer. Reopening with deny-WRITE while
            // the payload writes would turn a healthy task into a sharing error.
            if no_follow::final_path(&lease.file)?!=lease.named{return Err(io::ErrorKind::PermissionDenied.into());}
            Ok(maximum.max(lease.file.metadata()?.len()))
        })
    }
    pub fn retire(&mut self) -> io::Result<()> {
        if !self.stopped.load(Ordering::Acquire) { return Err(io::ErrorKind::PermissionDenied.into()); }
        for lease in self.leases.iter_mut().rev() { lease.restore()?; }
        self.profile.retire()
    }

    pub fn verify_process(&self, process: HANDLE) -> io::Result<()> {
        let mut token = 0;
        check(unsafe { OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE, &mut token) })?;
        let token = Handle(token);
        let app = information(token.0, TokenIsAppContainer)?;
        if app.len() * size_of::<usize>() < size_of::<u32>() || unsafe { *app.as_ptr().cast::<u32>() } != 1 { return Err(io::ErrorKind::PermissionDenied.into()); }
        let sid = information(token.0, TokenAppContainerSid)?;
        if unsafe { EqualSid((*sid.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>()).TokenAppContainer, self.capabilities.AppContainerSid) } == 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let capabilities = information(token.0, TokenCapabilities)?;
        if unsafe { (*capabilities.as_ptr().cast::<TOKEN_GROUPS>()).GroupCount } != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
        let restricted = information(token.0, TokenRestrictedSids)?;
        let count = unsafe { (*restricted.as_ptr().cast::<TOKEN_GROUPS>()).GroupCount } as usize;
        let base = unsafe { (*restricted.as_ptr().cast::<TOKEN_GROUPS>()).Groups.as_ptr() };
        if count > 128 || !((0..count).any(|index| unsafe { EqualSid((*base.add(index)).Sid, self.restriction.0) } != 0)) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.require_aap_opt_out(token.0)
    }
    fn require_aap_opt_out(&self, token: HANDLE) -> io::Result<()> {
        // TokenIsLessPrivilegedAppContainer is not queryable on every supported
        // Windows build. Verify the defining access boundary on this exact
        // suspended child: AAP alone must not grant a file read. The sentinel
        // contains no content and belongs only to this original run.
        let data = std::env::var("DEEPAGENT_WORK_DATA_ROOT").map_err(|_| io::ErrorKind::Unsupported)?;
        let parent = no_follow::LockedPath::open(Path::new(&data), true, false)?;
        let name = format!(".dac-lpac-{}", self.profile.name.iter().take_while(|unit| **unit != 0)
            .map(|unit| char::from_u32(*unit as u32).ok_or(io::ErrorKind::InvalidData)).collect::<Result<String,_>>()?);
        let user = information(self.token.0, TokenUser)?;
        let mut owner = ptr::null_mut();
        check(unsafe { windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid,&mut owner) })?;
        let mut len = 0; while len < 256 && unsafe { *owner.add(len) } != 0 { len += 1; }
        let text = String::from_utf16(unsafe { std::slice::from_raw_parts(owner,len) }).map_err(|_| io::ErrorKind::InvalidData);
        unsafe { LocalFree(owner.cast()); }
        let descriptor_text = wide(format!("O:{}D:P(A;;FA;;;{})(A;;FA;;;SY)(A;;0x120089;;;S-1-15-2-1)", text.as_ref().map_err(|_|io::ErrorKind::InvalidData)?,text.as_ref().map_err(|_|io::ErrorKind::InvalidData)?));
        let mut descriptor = ptr::null_mut();
        check(unsafe { windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor_text.as_ptr(),1,&mut descriptor,ptr::null_mut()) })?;
        let sentinel = super::windows_sentinel::Sentinel::create(parent,&name,descriptor);
        unsafe { LocalFree(descriptor); }
        let sentinel = sentinel?;
        check(unsafe { ImpersonateLoggedOnUser(token) })?;
        let opened = unsafe { CreateFileW(wide(sentinel.path()).as_ptr(),0x120089,7,ptr::null(),OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,0) };
        let code = io::Error::last_os_error().raw_os_error();
        if opened != 0 && opened != -1 { unsafe { CloseHandle(opened); } }
        let reverted = unsafe { RevertToSelf() }; check(reverted)?;
        sentinel.retire()?;
        if (opened != 0 && opened != -1) || code != Some(5) { return Err(io::ErrorKind::PermissionDenied.into()); }
        Ok(())
    }
}

struct Descriptor { allocation: *mut c_void, owner: PSID, dacl: *mut windows_sys::Win32::Security::ACL, control: u16 }
impl Descriptor {
    fn read(file: &File) -> io::Result<Self> {
        let mut owner = ptr::null_mut();
        let mut dacl = ptr::null_mut();
        let mut allocation = ptr::null_mut();
        if unsafe { GetSecurityInfo(file.as_raw_handle() as HANDLE, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner, ptr::null_mut(), &mut dacl, ptr::null_mut(), &mut allocation) } != 0 {
            if !allocation.is_null() { unsafe { LocalFree(allocation); } }
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let mut value = Self { allocation, owner, dacl, control: 0 };
        let mut revision = 0;
        check(unsafe { GetSecurityDescriptorControl(allocation, &mut value.control, &mut revision) })?;
        acl_bytes(dacl,unsafe{(*dacl).AceCount})?;
        Ok(value)
    }
}
impl Drop for Descriptor { fn drop(&mut self) { unsafe { LocalFree(self.allocation); } } }
fn acl_bytes(dacl: *mut windows_sys::Win32::Security::ACL,count:u16) -> io::Result<Vec<u8>> {
    crate::native_windows::acl::bytes(dacl,count)
}
fn acl_shape(value:&[u8])->String{
    let mut offset=8usize;let mut entries=Vec::new();
    while offset+8<=value.len(){
        let length=u16::from_le_bytes([value[offset+2],value[offset+3]])as usize;
        if length<8||offset+length>value.len(){return "invalid".into();}
        entries.push(format!("{}:{}:{}:{}:{:x}",value[offset],value[offset+1],length,
            u32::from_le_bytes(value[offset+4..offset+8].try_into().expect("validated ACE")),Sha256::digest(&value[offset+8..offset+length])));
        offset+=length;
    }
    format!("{}:{}:{}:{}",value[0],value.len(),u16::from_le_bytes([value[4],value[5]]),entries.join(","))
}

fn information(token: HANDLE, class: i32) -> io::Result<Vec<usize>> {
    let mut length = 0;
    unsafe { GetTokenInformation(token, class, ptr::null_mut(), 0, &mut length); }
    if length == 0 || length > 65_536 { return Err(io::ErrorKind::PermissionDenied.into()); }
    let mut data = vec![0usize; (length as usize + size_of::<usize>() - 1) / size_of::<usize>()];
    check(unsafe { GetTokenInformation(token, class, data.as_mut_ptr().cast(), length, &mut length) })?;
    Ok(data)
}
pub fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> { value.as_ref().encode_wide().chain(std::iter::once(0)).collect() }

fn exact_namespace(run: &Run, prepared: &common::Prepared) -> io::Result<()> {
    use std::collections::BTreeSet;
    use std::os::windows::fs::MetadataExt;
    let expected = run.inputs.iter().map(|input| input.relative.clone()).chain(run.outputs.iter().cloned()).collect::<BTreeSet<_>>();
    let mut pending = vec![String::new()];
    let mut actual = BTreeSet::new();
    let mut identities = BTreeSet::new();
    while let Some(relative) = pending.pop() {
        for entry in std::fs::read_dir(prepared.root.path.join(&relative))? {
            let entry = entry?;
            let name = entry.file_name().into_string().map_err(|_| io::ErrorKind::InvalidData)?;
            let path = if relative.is_empty() { name } else { format!("{relative}/{name}") };
            let parts = no_follow::relative(&path)?;
            let metadata = entry.path().symlink_metadata()?;
            if parts.len() > 16 || metadata.file_attributes() & 0x400 != 0 { return Err(io::ErrorKind::PermissionDenied.into()); }
            if metadata.is_dir() && relative.is_empty() && [".dac-home", ".dac-tmp"].contains(&path.as_str()) {
                let held = no_follow::LockedPath::open(&entry.path(),true,false)?;
                crate::native_windows::private_directory::require_private(&held.file)?;
                held.current()?;
                if std::fs::read_dir(entry.path())?.next().is_some() { return Err(io::ErrorKind::PermissionDenied.into()); }
                continue;
            }
            if metadata.is_dir() && expected.iter().any(|value| value.starts_with(&format!("{path}/"))) {
                pending.push(path); continue;
            }
            let file = no_follow::open_relative(&prepared.root.file, &parts)?;
            if !metadata.is_file() || !expected.contains(&path) || !actual.insert(path) ||
                !identities.insert(format!("{:?}", no_follow::identity(&file)?)) {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
        }
    }
    if actual != expected { return Err(io::ErrorKind::PermissionDenied.into()); }
    prepared.root.current()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use windows_sys::Win32::{Security::SECURITY_ATTRIBUTES, Storage::FileSystem::{CREATE_NEW, FILE_ATTRIBUTE_NORMAL,
        FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_DELETE}, System::Threading::GetCurrentProcessId};

    // Setup creates a new QA-only object with its protected DACL at creation.
    // The restore under test is the same production AclLease implementation.
    fn lease(stopped: bool) -> (std::path::PathBuf, AclLease, Vec<u8>) {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = crate::native_windows::private_directory::Descriptor::command_input().unwrap();
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("dac-acl-retire-{}-{nonce}-{}", unsafe { GetCurrentProcessId() }, NEXT.fetch_add(1, Ordering::Relaxed)));
        let attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: directory.pointer().cast_mut(), bInheritHandle: 0 };
        let handle = unsafe { CreateFileW(wide(&path).as_ptr(), FILE_GENERIC_READ | FILE_GENERIC_WRITE | 0x0004_0000,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, 0) };
        assert!(handle != 0 && handle != -1);
        let file = File::from(unsafe { OwnedHandle::from_raw_handle(handle as *mut c_void) });
        let original = Descriptor::read(&file).unwrap();
        let before = acl_bytes(original.dacl,2).unwrap();
        let mut restriction = ptr::null_mut();
        check(unsafe { ConvertStringSidToSidW(wide("S-1-5-21-1-2-3-4").as_ptr(), &mut restriction) }).unwrap();
        let restriction = Restriction(restriction);
        let mut app = ptr::null_mut();
        check(unsafe { ConvertStringSidToSidW(wide("S-1-15-2-1-2-3-4-5-6-7").as_ptr(), &mut app) }).unwrap();
        let app = Restriction(app);
        let entry = |sid:PSID| EXPLICIT_ACCESS_W { grfAccessPermissions: 0x0012_0089, grfAccessMode: GRANT_ACCESS, grfInheritance: 0,
            Trustee: TRUSTEE_W { pMultipleTrustee: ptr::null_mut(), MultipleTrusteeOperation: 0, TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN, ptstrName: sid.cast() } };
        let entries=[entry(restriction.0),entry(app.0)];
        let mut dacl = ptr::null_mut();
        assert_eq!(unsafe { SetEntriesInAclW(2, entries.as_ptr(), original.dacl, &mut dacl) }, 0);
        let granted = acl_bytes(dacl,4).unwrap();
        assert_eq!(unsafe { SetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(), ptr::null_mut(), dacl, ptr::null()) }, 0);
        unsafe { LocalFree(dacl.cast()); }
        let named=no_follow::final_path(&file).unwrap();
        let lease = AclLease { file, original: original.allocation, dacl: original.dacl, owner: original.owner, changed: true,
            flags: DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, granted,
            stopped: Arc::new(AtomicBool::new(stopped)), retirement_attempted: false, writable:false, named };
        std::mem::forget(original);
        (path, lease, before)
    }

    #[test]
    fn actual_acl_restore_requires_stopped_tree_and_exact_readback() {
        let (path, mut lease, before) = lease(false);
        assert!(lease.restore().is_err());
        assert!(!lease.retirement_attempted);
        assert_eq!(acl_bytes(Descriptor::read(&lease.file).unwrap().dacl,4).unwrap(), lease.granted);
        lease.stopped.store(true, Ordering::Release);
        lease.restore().unwrap();
        assert!(!lease.changed);
        assert_eq!(acl_bytes(Descriptor::read(&lease.file).unwrap().dacl,2).unwrap(), before);
        drop(lease);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn actual_foreign_acl_change_is_retained_and_never_retried() {
        let (path, mut lease, before) = lease(true);
        // Independently retire the grant before this lease attempts restoration.
        assert_eq!(unsafe { SetSecurityInfo(lease.file.as_raw_handle() as HANDLE, SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(), ptr::null_mut(), lease.dacl, ptr::null()) }, 0);
        assert!(lease.restore().is_err());
        assert!(lease.retirement_attempted);
        assert!(lease.restore().is_err());
        assert_eq!(acl_bytes(Descriptor::read(&lease.file).unwrap().dacl,2).unwrap(), before);
        drop(lease);
        std::fs::remove_file(path).unwrap();
    }
}

fn phase<A>(stage:&'static str,value:io::Result<A>)->io::Result<A>{value.inspect_err(|error|eprintln!("WINDOWS_COMMAND_SECURITY_FAILURE stage={stage} kind={:?} os={}",error.kind(),error.raw_os_error().unwrap_or(0)))}
