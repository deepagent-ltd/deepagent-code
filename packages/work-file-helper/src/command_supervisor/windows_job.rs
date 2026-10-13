//! No compatibility resume after a failed Job assignment. The process remains
//! suspended until both containment and original Host authorization succeed.
use super::protocol::{Isolation, Run};
use std::{io, mem::{size_of, zeroed}};
use windows_sys::Win32::{Foundation::{CloseHandle, HANDLE}, System::{JobObjects::{AssignProcessToJobObject,
    CreateJobObjectW, IsProcessInJob, QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOBOBJECT_BASIC_UI_RESTRICTIONS, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, JobObjectCpuRateControlInformation, JobObjectBasicUIRestrictions,
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_JOB_TIME, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP}, Threading::ResumeThread}};

pub struct Job(HANDLE);
impl Drop for Job { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }

impl Job {
    pub fn create(run: &Run) -> io::Result<Self> {
        let Isolation::Windows { cpu, job_commit_max_bytes, job_processes_max, .. } = &run.isolation
            else { return Err(io::ErrorKind::Unsupported.into()); };
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle == 0 { return Err(io::Error::last_os_error()); }
        let job = Self(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
            JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_JOB_TIME;
        limits.BasicLimitInformation.ActiveProcessLimit = *job_processes_max;
        limits.BasicLimitInformation.PerJobUserTimeLimit = cpu.job_user_time_limit_100ns as i64;
        limits.JobMemoryLimit = *job_commit_max_bytes as usize;
        job.set(JobObjectExtendedLimitInformation, &limits)?;
        let rate = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION { ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
            Anonymous: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0 { CpuRate: cpu.hard_cap_percent * 100 } };
        job.set(JobObjectCpuRateControlInformation, &rate)?;
        // No clipboard, desktop, display, global-atom or window-handle escape.
        job.set(JobObjectBasicUIRestrictions, &JOBOBJECT_BASIC_UI_RESTRICTIONS { UIRestrictionsClass: 0xff })?;
        let actual: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = job.query(JobObjectExtendedLimitInformation)?;
        let actual_rate: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION = job.query(JobObjectCpuRateControlInformation)?;
        if actual.BasicLimitInformation.LimitFlags != limits.BasicLimitInformation.LimitFlags ||
            actual.BasicLimitInformation.LimitFlags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) != 0 ||
            actual.BasicLimitInformation.ActiveProcessLimit != 1 || actual.JobMemoryLimit != limits.JobMemoryLimit ||
            actual.BasicLimitInformation.PerJobUserTimeLimit != limits.BasicLimitInformation.PerJobUserTimeLimit ||
            actual_rate.ControlFlags != rate.ControlFlags || unsafe { actual_rate.Anonymous.CpuRate } != cpu.hard_cap_percent * 100 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(job)
    }

    pub fn attach(&self, process: HANDLE) -> io::Result<()> {
        check(unsafe { AssignProcessToJobObject(self.0, process) })?;
        let mut assigned = 0;
        check(unsafe { IsProcessInJob(process, self.0, &mut assigned) })?;
        if assigned == 0 || self.accounting()?.ActiveProcesses != 1 { return Err(io::ErrorKind::PermissionDenied.into()); }
        Ok(())
    }
    pub fn resume(&self, thread: HANDLE) -> io::Result<()> {
        let previous = unsafe { ResumeThread(thread) };
        if previous == u32::MAX { return Err(io::Error::last_os_error()); }
        if previous != 1 { return Err(io::ErrorKind::PermissionDenied.into()); }
        Ok(())
    }
    pub fn stop(&self) -> io::Result<()> { check(unsafe { TerminateJobObject(self.0, 125) }) }
    pub fn empty(&self) -> io::Result<bool> { self.accounting().map(|value| value.ActiveProcesses == 0) }
    pub fn cpu_micros(&self) -> io::Result<u64> {
        let value = self.accounting()?;
        let total = value.TotalUserTime.checked_add(value.TotalKernelTime).ok_or(io::ErrorKind::InvalidData)?;
        if total < 0 { return Err(io::ErrorKind::InvalidData.into()); }
        Ok(total as u64 / 10)
    }
    fn accounting(&self) -> io::Result<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION> { self.query(JobObjectBasicAccountingInformation) }
    fn set<T>(&self, class: i32, value: &T) -> io::Result<()> {
        check(unsafe { SetInformationJobObject(self.0, class, (value as *const T).cast(), size_of::<T>() as u32) })
    }
    fn query<T>(&self, class: i32) -> io::Result<T> {
        let mut value = std::mem::MaybeUninit::<T>::uninit();
        let mut length = 0;
        check(unsafe { QueryInformationJobObject(self.0, class, value.as_mut_ptr().cast(), size_of::<T>() as u32, &mut length) })?;
        if length as usize != size_of::<T>() { return Err(io::ErrorKind::InvalidData.into()); }
        Ok(unsafe { value.assume_init() })
    }
}
pub fn check(value: i32) -> io::Result<()> { if value == 0 { return Err(io::Error::last_os_error()); } Ok(()) }
