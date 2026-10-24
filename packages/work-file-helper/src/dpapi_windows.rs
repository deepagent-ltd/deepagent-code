//! One-shot helper DPAPI. The Node event loop never calls Crypt32 synchronously.
use std::{io, ptr};
use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN}};

// Owned copies in the helper and Native pipe queues are wiped on normal/error
// exits. Forced Job termination uses OS reclamation and cannot promise Drop.
pub struct SecretBytes(pub Vec<u8>);
impl Drop for SecretBytes {
    fn drop(&mut self) { wipe(&mut self.0); }
}
pub fn wipe(bytes: &mut [u8]) {
    for byte in bytes { unsafe { ptr::write_volatile(byte, 0); } }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

// Exactly the existing CurrentUser DPAPI format: no machine flag, optional entropy,
// description or prompt. Native output is wiped before LocalFree on every exit.
pub struct ProtectedOutput(CRYPT_INTEGER_BLOB);
impl ProtectedOutput {
    pub fn bytes(&self) -> &[u8] {
        if self.0.cbData == 0 { return &[]; }
        unsafe { std::slice::from_raw_parts(self.0.pbData, self.0.cbData as usize) }
    }
}
impl Drop for ProtectedOutput {
    fn drop(&mut self) {
        if self.0.pbData.is_null() { return; }
        for offset in 0..self.0.cbData as usize {
            unsafe { ptr::write_volatile(self.0.pbData.add(offset), 0); }
        }
        std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
        unsafe { LocalFree(self.0.pbData.cast()); }
    }
}
pub fn crypt_secret(bytes: &[u8], protect: bool) -> io::Result<ProtectedOutput> {
    let input_limit = if protect { 65_536 } else { 98_304 };
    if bytes.len() > input_limit { return Err(io::ErrorKind::InvalidInput.into()); }
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
    let mut output = ProtectedOutput(CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() });
    let ok = unsafe { if protect {
        CryptProtectData(&input, ptr::null(), ptr::null(), ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output.0)
    } else {
        CryptUnprotectData(&input, ptr::null_mut(), ptr::null(), ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output.0)
    }};
    if ok == 0 { return Err(io::Error::last_os_error()); }
    let output_limit = if protect { 98_304 } else { 65_536 };
    if output.0.cbData as usize > output_limit || (output.0.cbData != 0 && output.0.pbData.is_null()) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(output)
}

#[cfg(test)]
mod codec_tests {
    use super::*;
    fn legacy_dotnet(bytes: &[u8], protect: bool) -> Vec<u8> {
        use std::{io::Write, process::{Command, Stdio}, time::{Duration, Instant}};
        let executable = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        assert!(executable.is_absolute());
        let method = if protect { "Protect" } else { "Unprotect" };
        let script = format!("$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$b=[IO.MemoryStream]::new();[Console]::OpenStandardInput().CopyTo($b);$v=[Security.Cryptography.ProtectedData]::{method}($b.ToArray(),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::OpenStandardOutput().Write($v,0,$v.Length)");
        let mut child = Command::new(executable).args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() >= deadline {
                child.kill().unwrap(); child.wait().unwrap();
                panic!("DPAPI compatibility subprocess exceeded its owned timeout");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "DPAPI compatibility subprocess failed");
        output.stdout
    }
    #[test]
    fn current_user_dpapi_roundtrip_and_bounds() {
        for input in [Vec::new(), vec![0, 1, 127, 128, 255], vec![42; 65_536]] {
            let encrypted = crypt_secret(&input, true).unwrap();
            assert!(!encrypted.bytes().is_empty());
            let decrypted = crypt_secret(encrypted.bytes(), false).unwrap();
            assert_eq!(decrypted.bytes(), input);
        }
        let synthetic = b"owned-codec-compatibility";
        let encrypted = crypt_secret(synthetic, true).unwrap();
        let mut old_decoded = legacy_dotnet(encrypted.bytes(), false);
        assert!(old_decoded == synthetic); old_decoded.fill(0);
        let old_encrypted = legacy_dotnet(synthetic, true);
        let decoded = crypt_secret(&old_encrypted, false).unwrap();
        assert_eq!(decoded.bytes(), synthetic);
        assert!(crypt_secret(&vec![0; 65_537], true).is_err());
        assert!(crypt_secret(&vec![0; 98_305], false).is_err());
    }
    #[test]
    fn current_user_dpapi_rejects_invalid_ciphertext() {
        assert!(crypt_secret(&[], false).is_err());
        assert!(crypt_secret(&[0, 1, 2, 3], false).is_err());
        let encrypted = crypt_secret(b"owned-codec-test", true).unwrap();
        let mut damaged = encrypted.bytes().to_vec();
        let last = damaged.len() - 1; damaged[last] ^= 1;
        assert!(crypt_secret(&damaged, false).is_err());
    }
}
