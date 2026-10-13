//! Exact comparison for this command's private two-ACE or four-ACE DACL only.
//! Windows may reorder allow ACEs and discard unused ACL allocation space on
//! publication. Preserve every complete ACE and duplicate; reject other types.
use std::{io,mem::{size_of,zeroed},ptr};
use windows_sys::Win32::Security::{ACL,ACL_SIZE_INFORMATION,AclSizeInformation,GetAclInformation,IsValidAcl};
pub(crate) fn bytes(value:*mut ACL,expected_count:u16)->io::Result<Vec<u8>>{
    if value.is_null()||unsafe{IsValidAcl(value)}==0{return Err(io::ErrorKind::PermissionDenied.into());}
    let mut size:ACL_SIZE_INFORMATION=unsafe{zeroed()};
    if unsafe{GetAclInformation(value,(&raw mut size).cast(),size_of::<ACL_SIZE_INFORMATION>()as u32,AclSizeInformation)}==0{return Err(io::Error::last_os_error());}
    let header=unsafe{ptr::read(value)};
    if ![2,4].contains(&expected_count)||header.AceCount!=expected_count||
        ![2,4].contains(&header.AclRevision)||header.Sbz1!=0||header.Sbz2!=0||size.AceCount!=header.AceCount as u32||
        size.AclBytesInUse<8||size.AclBytesInUse>header.AclSize as u32||size.AclBytesInUse+size.AclBytesFree!=header.AclSize as u32{
        return Err(io::ErrorKind::InvalidData.into());
    }
    let bytes=unsafe{std::slice::from_raw_parts(value.cast::<u8>(),size.AclBytesInUse as usize)};
    let mut offset=8usize;let mut entries=Vec::with_capacity(expected_count as usize);
    for _ in 0..expected_count{
        if offset+8>bytes.len()||bytes[offset]!=0{return Err(io::ErrorKind::PermissionDenied.into());}
        let length=u16::from_le_bytes([bytes[offset+2],bytes[offset+3]])as usize;
        if length<20||length%4!=0||offset+length>bytes.len(){return Err(io::ErrorKind::InvalidData.into());}
        let sid=bytes[offset+8..offset+length].as_ptr()as *mut std::ffi::c_void;
        if unsafe{windows_sys::Win32::Security::IsValidSid(sid)}==0||
            unsafe{windows_sys::Win32::Security::GetLengthSid(sid)}as usize!=length-8{
            return Err(io::ErrorKind::InvalidData.into());
        }
        entries.push(&bytes[offset..offset+length]);offset+=length;
    }
    if offset!=bytes.len(){return Err(io::ErrorKind::InvalidData.into());}
    entries.sort_unstable();
    let mut canonical=bytes[..8].to_vec();canonical[2..4].copy_from_slice(&(bytes.len()as u16).to_le_bytes());
    for entry in entries{canonical.extend_from_slice(entry);}
    Ok(canonical)
}
