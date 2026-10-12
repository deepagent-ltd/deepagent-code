//! A defining LPAC access check on the exact suspended payload token. The empty
//! sentinel is owned by this run, and retirement deletes its original handle.
use crate::{no_follow, protocol::Identity};
use std::{ffi::c_void, fs::File, io, mem::size_of, os::windows::{ffi::OsStrExt, io::{AsRawHandle, FromRawHandle, OwnedHandle}}, path::PathBuf, ptr};
use windows_sys::Win32::{Foundation::{HANDLE, NTSTATUS, RtlNtStatusToDosError, UNICODE_STRING},
    Storage::FileSystem::{FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_DISPOSITION_INFO,
        FileDispositionInfo, SetFileInformationByHandle}, System::{IO::{IO_STATUS_BLOCK, IO_STATUS_BLOCK_0},
        Kernel::{OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE}}};
#[repr(C)]
struct Attributes { length:u32, root:HANDLE, name:*const UNICODE_STRING, flags:u32, descriptor:*const c_void, quality:*const c_void }
#[link(name="ntdll")]
unsafe extern "system" {
    fn NtCreateFile(handle:*mut HANDLE, access:u32, attributes:*const Attributes, status:*mut IO_STATUS_BLOCK,
        allocation:*const i64, flags:u32, sharing:u32, disposition:u32, options:u32, ea:*const c_void, ea_bytes:u32)->NTSTATUS;
}
pub(super) struct Sentinel { parent:no_follow::LockedPath, file:File, identity:Identity, path:PathBuf }
impl Sentinel {
    pub(super) fn create(parent:no_follow::LockedPath, name:&str, descriptor:*const c_void)->io::Result<Self> {
        if descriptor.is_null() || name.len()>192 || !name.starts_with(".dac-lpac-") ||
            name.chars().any(|unit| !(unit.is_ascii_alphanumeric() || "._-".contains(unit))) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        parent.current()?;
        let mut encoded=std::ffi::OsStr::new(name).encode_wide().collect::<Vec<_>>();
        let size=u16::try_from(encoded.len()*2).map_err(|_|io::ErrorKind::InvalidInput)?;
        let mut unicode=UNICODE_STRING {Length:size,MaximumLength:size,Buffer:encoded.as_mut_ptr()};
        let attributes=Attributes {length:size_of::<Attributes>()as u32,root:parent.file.as_raw_handle()as HANDLE,
            name:&raw mut unicode,flags:OBJ_CASE_INSENSITIVE as u32|OBJ_DONT_REPARSE as u32,descriptor,quality:ptr::null()};
        let mut status=IO_STATUS_BLOCK {Anonymous:IO_STATUS_BLOCK_0 {Status:0},Information:0};let mut handle=0;
        // DELETE belongs only to this original owner handle. Read observers
        // share that desired access; no writer or namespace replacer is shared.
        let result=unsafe {NtCreateFile(&mut handle,FILE_GENERIC_READ|0x10000,&attributes,&mut status,ptr::null(),
            FILE_ATTRIBUTE_NORMAL,FILE_SHARE_READ,2,0x20|0x40,ptr::null(),0)};
        if result<0{return Err(io::Error::from_raw_os_error(unsafe {RtlNtStatusToDosError(result)}as i32));}
        if handle==0||handle==-1{return Err(io::ErrorKind::InvalidData.into());}
        let file=File::from(unsafe {OwnedHandle::from_raw_handle(handle as *mut c_void)});
        let identity=no_follow::identity(&file)?;let path=parent.canonical().join(name);
        let value=Self {parent,file,identity,path};value.current()?;Ok(value)
    }
    pub(super) fn path(&self)->&std::path::Path {&self.path}
    fn current(&self)->io::Result<()> {
        self.parent.current()?;
        if no_follow::identity(&self.file)?!=self.identity || self.file.metadata()?.len()!=0 ||
            no_follow::final_path(&self.file)?!=self.path {return Err(io::ErrorKind::PermissionDenied.into());}Ok(())
    }
    pub(super) fn retire(self)->io::Result<()> {
        self.current()?;let delete=FILE_DISPOSITION_INFO {DeleteFile:1};
        if unsafe {SetFileInformationByHandle(self.file.as_raw_handle()as HANDLE,FileDispositionInfo,
            (&raw const delete).cast(),size_of::<FILE_DISPOSITION_INFO>()as u32)}==0{return Err(io::Error::last_os_error());}
        let Self {parent,file,path,..}=self;drop(file);parent.current()?;
        match std::fs::symlink_metadata(path) {
            Err(error)if error.kind()==io::ErrorKind::NotFound=>Ok(()),
            _=>Err(io::ErrorKind::PermissionDenied.into()),
        }
    }
}
