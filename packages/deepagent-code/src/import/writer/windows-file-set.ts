export * as WindowsFileSet from "./windows-file-set"

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { gzipSync } from "node:zlib"
import fs from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { Schema } from "effect"

const Tree = Schema.Struct({
  identity: Schema.Struct({ device: Schema.String, inode: Schema.String }),
  files: Schema.Array(Schema.Struct({ relative: Schema.String, bytes: Schema.Int, sha256: Schema.String })),
  directories: Schema.Array(Schema.String),
  bytes: Schema.Int,
})
export type Tree = typeof Tree.Type
const Frame = Schema.Struct({
  protocol: Schema.Literal(1),
  nonce: Schema.String,
  seq: Schema.Int,
  phase: Schema.Literals(["result", "checkpoint", "error"]),
  value: Schema.optional(Schema.Unknown),
  index: Schema.optional(Schema.Int),
  code: Schema.optional(Schema.NullOr(Schema.String)),
})

// One fixed inbox OS bridge owns only one internally-created import job tree.
// Directory publication follows Microsoft's same-volume, absent-target MoveFileEx example:
// https://learn.microsoft.com/en-us/windows/win32/fileio/moving-directories
// Directory flushes use NtFlushBuffersFileEx(flags=0), with every error retained.
// These are OS API contracts; no physical power-loss experiment is claimed.
const script = String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
try {
  if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){throw 'unsupported_language_mode'}
  Import-Module -Name ($PSHOME+'/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
  Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -TypeDefinition @'
using System;
using System.IO;
using System.Linq;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
public static class DacImportFileSet {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;
    public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long Created,Accessed,Written,Changed; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct FindData {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;
    public uint SizeHigh,SizeLow,Reserved0,Reserved1;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=14)] public string Alternate;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out Info info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr file,int kind,out Basic info,uint bytes);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr file,StringBuilder name,uint size,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationByHandleW(IntPtr file,IntPtr name,uint size,out uint serial,out uint component,out uint flags,StringBuilder system,uint capacity);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(IntPtr file);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool MoveFileExW(string source,string target,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string name,ref SecurityAttributes security);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr file);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFileAttributesW(string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstFileW(string pattern,out FindData data);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool FindNextFileW(IntPtr find,out FindData data);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool FindClose(IntPtr find);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,uint version,out IntPtr descriptor,out uint bytes);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr file,int kind,uint fields,out IntPtr owner,IntPtr group,out IntPtr dacl,IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr file,int kind,uint fields,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern bool GetSecurityDescriptorOwner(IntPtr descriptor,out IntPtr owner,out bool defaulted);
  [DllImport("advapi32.dll")] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
  [DllImport("ntdll.dll")] static extern int NtFlushBuffersFileEx(IntPtr file,uint flags,IntPtr parameters,uint bytes,out IoStatus status);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=8388608,RecursionLimit=128 };
  static readonly string Sid=WindowsIdentity.GetCurrent().User.Value;
  static readonly Dictionary<string,IntPtr> Directories=new Dictionary<string,IntPtr>(StringComparer.OrdinalIgnoreCase);
  static readonly List<IntPtr> Held=new List<IntPtr>();
  static string Root,Nonce,Step;
  static int Sequence,Checks;
  public sealed class Identity { public string device,inode; }
  public sealed class Entry { public string relative,sha256; public int bytes; }
  public sealed class Snapshot { public Identity identity; public List<Entry> files=new List<Entry>(); public List<string> directories=new List<string>(); public int bytes; }
  sealed class BudgetError : Exception {}
  static void Need(bool value) { if(!value) throw new InvalidDataException(); }
  static void Budget(bool value) { if(!value) throw new BudgetError(); }
  static void Win(bool value) { if(!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Emit(string phase,object value=null,int index=0,string code=null) {
    Console.Out.WriteLine(Json.Serialize(new {protocol=1,nonce=Nonce,seq=Sequence,phase=phase,value=value,index=index,code=code}));
    Console.Out.Flush();
  }
  static Dictionary<string,object> Input() {
    string line=Console.ReadLine(); if(line==null) throw new EndOfStreamException();
    Need(line.Length<=8388608);return Json.Deserialize<Dictionary<string,object>>(line);
  }
  static string Text(Dictionary<string,object> input,string key) { object value;Need(input.TryGetValue(key,out value)&&value is string);return (string)value; }
  static int Number(Dictionary<string,object> input,string key) { object value;Need(input.TryGetValue(key,out value)&&value is int);return (int)value; }
  static bool Flag(Dictionary<string,object> input,string key) { object value;Need(input.TryGetValue(key,out value)&&value is bool);return (bool)value; }
  static void Envelope(Dictionary<string,object> input) { Need(Number(input,"protocol")==1&&Text(input,"nonce")==Nonce&&Number(input,"seq")==Sequence); }
  static string Relative(string value) {
    Need(value.Length<=2048&&!value.Contains('\\')&&!value.Contains(':')&&!value.Contains('\0'));
    if(value=="") return value;
    string[] parts=value.Split('/');Need(parts.Length<=32&&parts.All(x=>x!=""&&x!="."&&x!=".."&&!x.Any(c=>c<32||c==127)));
    return value;
  }
  static string Extended(string filename) { Need(filename.Length<32760);return filename.StartsWith(@"\\?\")?filename:@"\\?\"+filename; }
  static string Name(string relative) { return relative==""?Root:Root+"\\"+Relative(relative).Replace('/','\\'); }
  static uint Attributes(string filename,bool absent=false) {
    uint result=GetFileAttributesW(Extended(filename));if(result!=0xffffffff) return result;
    int error=Marshal.GetLastWin32Error();if(absent&&(error==2||error==3)) return result;throw new Win32Exception(error);
  }
  static string[] Children(string filename) {
    FindData data;IntPtr find=FindFirstFileW(Extended(filename)+"\\*",out data);
    if(find==new IntPtr(-1)) {int error=Marshal.GetLastWin32Error();if(error==2) return new string[0];throw new Win32Exception(error);}
    var names=new List<string>();
    try {
      for(;;) {
        if(data.Name!="."&&data.Name!="..") {Budget(names.Count<10000);names.Add(data.Name);}
        if(FindNextFileW(find,out data)) continue;int error=Marshal.GetLastWin32Error();if(error!=18)throw new Win32Exception(error);break;
      }
    } finally {Win(FindClose(find));}
    names.Sort(StringComparer.Ordinal);return names.ToArray();
  }
  static Info Read(IntPtr file,bool directory) {
    Info info;Win(GetFileInformationByHandle(file,out info));Need((info.Attributes&0x400)==0&&((info.Attributes&0x10)!=0)==directory);return info;
  }
  static Identity Id(Info info) { return new Identity {device=info.Volume.ToString(),inode=(((ulong)info.IndexHigh<<32)|info.IndexLow).ToString()}; }
  static bool Same(Info a,Info b) { return a.Volume==b.Volume&&a.IndexHigh==b.IndexHigh&&a.IndexLow==b.IndexLow; }
  static void Canonical(IntPtr file,string filename) {
    var buffer=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(file,buffer,(uint)buffer.Capacity,0);Win(n>0&&n<buffer.Capacity);
    string actual=buffer.ToString();if(actual.StartsWith(@"\\?\")) actual=actual.Substring(4);
    Need(String.Equals(actual.TrimEnd('\\'),filename.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase));
  }
  static IntPtr Open(string filename,bool directory,bool write,bool movable,bool observe=false) {
    IntPtr file=CreateFileW(Extended(filename),(write?0xC00E0000u:0x80020000u),1u|((directory||observe)?2u:0u)|(movable?4u:0u),IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    Win(file!=new IntPtr(-1));try { Read(file,directory);Canonical(file,filename);return file; } catch {CloseHandle(file);throw;}
  }
  static DirectorySecurity Security(IntPtr file) {
    IntPtr owner,dacl,descriptor;uint error=GetSecurityInfo(file,1,5,out owner,IntPtr.Zero,out dacl,IntPtr.Zero,out descriptor);
    if(error!=0) throw new Win32Exception((int)error);
    try {uint length=GetSecurityDescriptorLength(descriptor);Need(length>0&&length<=1048576);byte[] bytes=new byte[length];Marshal.Copy(descriptor,bytes,0,bytes.Length);var result=new DirectorySecurity();result.SetSecurityDescriptorBinaryForm(bytes);return result;} finally {LocalFree(descriptor);}
  }
  static void Owner(IntPtr file,bool initial,bool machine=false) {
    string owner=Security(file).GetOwner(typeof(SecurityIdentifier)).Value;
    Need(owner==Sid||(initial&&(owner=="S-1-5-18"||owner=="S-1-5-32-544"))||(machine&&owner=="S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"));
  }
  static void Private(IntPtr file) {
    var acl=Security(file);Need(acl.GetOwner(typeof(SecurityIdentifier)).Value==Sid&&acl.AreAccessRulesProtected);
    var rules=acl.GetAccessRules(true,true,typeof(SecurityIdentifier));Need(rules.Count>0);bool own=false;
    foreach(FileSystemAccessRule rule in rules) {
      string sid=rule.IdentityReference.Value;
      Need(rule.AccessControlType==AccessControlType.Allow&&(sid==Sid||sid=="S-1-5-18"));
      if(sid==Sid&&(rule.FileSystemRights&FileSystemRights.FullControl)==FileSystemRights.FullControl) own=true;
    }
    Need(own);
  }
  static IntPtr Descriptor(bool directory) {
    string inherit=directory?"OICI":"";string text="O:"+Sid+"D:P(A;"+inherit+";FA;;;"+Sid+")(A;"+inherit+";FA;;;SY)";
    IntPtr result;uint bytes;Win(ConvertStringSecurityDescriptorToSecurityDescriptorW(text,1,out result,out bytes));return result;
  }
  static void Harden(IntPtr file,bool directory) {
    Owner(file,true);IntPtr descriptor=Descriptor(directory);
    try {IntPtr owner,dacl;bool present,defaulted;Win(GetSecurityDescriptorOwner(descriptor,out owner,out defaulted));Win(GetSecurityDescriptorDacl(descriptor,out present,out dacl,out defaulted));Need(present&&dacl!=IntPtr.Zero);
      uint error=SetSecurityInfo(file,1,0x80000005,owner,IntPtr.Zero,dacl,IntPtr.Zero);if(error!=0) throw new Win32Exception((int)error);
    } finally {LocalFree(descriptor);}Private(file);
  }
  static void FlushDirectory(IntPtr file) {
    Read(file,true);Private(file);IoStatus status;int result=NtFlushBuffersFileEx(file,0,IntPtr.Zero,0,out status);
    if(result<0) throw new Win32Exception((int)RtlNtStatusToDosError(result));
  }
  static IntPtr Directory(string relative,bool harden) {
    relative=Relative(relative);IntPtr file;
    if(Directories.TryGetValue(relative,out file)) {Canonical(file,Name(relative));Read(file,true);Private(file);return file;}
    string prefix="";file=Directories[""];
    foreach(string part in relative.Split(new[]{'/'},StringSplitOptions.RemoveEmptyEntries)) {
      prefix=prefix==""?part:prefix+"/"+part;
      if(Directories.TryGetValue(prefix,out file)) {Canonical(file,Name(prefix));Private(file);continue;}
      file=Open(Name(prefix),true,harden,false);if(harden) Harden(file,true);else Private(file);
      Held.Add(file);Directories.Add(prefix,file);
    }
    return file;
  }
  static void Init(string root,bool prepare) {
    if(root.StartsWith(@"\\?\")) root=root.Substring(4);
    Need(root.Length>3&&root.Length<32760&&root.IndexOf('\0')<0&&Char.IsLetter(root[0])&&root[1]==':'&&root[2]=='\\');
    Root=root.TrimEnd('\\');string prefix=Root.Substring(0,3);
    var parts=Root.Substring(3).Split(new[]{'\\'},StringSplitOptions.RemoveEmptyEntries);
    for(int i=-1;i<parts.Length;i++) {
      if(i>=0) prefix=prefix.TrimEnd('\\')+"\\"+parts[i];IntPtr file=Open(prefix,true,i==parts.Length-1,false);Held.Add(file);Owner(file,true,i<parts.Length-1);
      if(i==parts.Length-1) {if(prepare) Harden(file,true);else Private(file);Directories.Add("",file);uint serial,component,flags;var system=new StringBuilder(32);Win(GetVolumeInformationByHandleW(file,IntPtr.Zero,0,out serial,out component,out flags,system,32));Need(system.ToString()=="NTFS");}
    }
  }
  static void Prepare(string root,string relative) {
    root=Relative(root);relative=Relative(relative);IntPtr parent=Directory(root,true);string prefix=root;
    foreach(string part in relative.Split(new[]{'/'},StringSplitOptions.RemoveEmptyEntries)) {
      prefix=prefix==""?part:prefix+"/"+part;string filename=Name(prefix);IntPtr descriptor=Descriptor(true);
      try {var security=new SecurityAttributes {Length=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=descriptor};if(!CreateDirectoryW(Extended(filename),ref security)){int error=Marshal.GetLastWin32Error();if(error!=183) throw new Win32Exception(error);}} finally {LocalFree(descriptor);}
      IntPtr current=Directory(prefix,true);Need(Read(current,true).Volume==Read(parent,true).Volume);FlushDirectory(current);FlushDirectory(parent);parent=current;
    }
  }
  static void Checkpoint() {
    Checks++;Emit("checkpoint",null,Checks);var input=Input();Envelope(input);Need(Text(input,"phase")=="continue"&&Number(input,"index")==Checks);
  }
  static Snapshot Tree(string relative,bool sync,bool checkpoints) {
    relative=Relative(relative);var result=new Snapshot();int entries=0;IntPtr root=Open(Name(relative),true,sync,true);
    try {if(sync) Harden(root,true);else Private(root);Info identity=Read(root,true);result.identity=Id(identity);
      Action<string,int> visit=null;
      visit=(name,depth)=>{
        if(checkpoints) Checkpoint();Budget(++entries<=10000&&depth<=32);Relative(name);Need(Encoding.UTF8.GetByteCount(name)<=2048);
        string filename=name==""?Name(relative):Name(relative)+"\\"+name.Replace('/','\\');
        uint attributes=Attributes(filename);Need((attributes&0x400)==0);bool directory=(attributes&0x10)!=0;
        IntPtr file=Open(filename,directory,sync,true);
        try {if(sync) Harden(file,directory);else Private(file);Info before=Read(file,directory);Basic basic;Win(GetFileInformationByHandleEx(file,0,out basic,(uint)Marshal.SizeOf(typeof(Basic))));
          if(directory) {result.directories.Add(name);foreach(string child in Children(filename)) visit(name==""?child:name+"/"+child,depth+1);if(sync) FlushDirectory(file);Info after=Read(file,true);Need(Same(before,after));IntPtr namedDirectory=Open(filename,true,false,true);try{Need(Same(before,Read(namedDirectory,true)));Private(namedDirectory);}finally{Win(CloseHandle(namedDirectory));}return;}
          long length=((long)before.SizeHigh<<32)|before.SizeLow;Budget(before.Links==1&&length<=16777216&&result.bytes+length<=268435456);
          byte[] bytes=new byte[(int)length];using(var safe=new SafeFileHandle(file,false))using(var stream=new FileStream(safe,FileAccess.Read)){int read=0;while(read<bytes.Length){int n=stream.Read(bytes,read,bytes.Length-read);Need(n>0);read+=n;}Need(stream.ReadByte()==-1);}
          if(sync) Win(FlushFileBuffers(file));Info final=Read(file,false);Basic afterBasic;Win(GetFileInformationByHandleEx(file,0,out afterBasic,(uint)Marshal.SizeOf(typeof(Basic))));
          Need(Same(before,final)&&before.SizeHigh==final.SizeHigh&&before.SizeLow==final.SizeLow&&final.Links==1&&basic.Written==afterBasic.Written&&basic.Changed==afterBasic.Changed);
          IntPtr namedFile=Open(filename,false,false,true,true);try{Need(Same(before,Read(namedFile,false)));Private(namedFile);}finally{Win(CloseHandle(namedFile));}
          using(var hash=SHA256.Create()) result.files.Add(new Entry {relative=name,bytes=bytes.Length,sha256=BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant()});result.bytes+=bytes.Length;
        } finally {Win(CloseHandle(file));}
      };
      visit("",0);IntPtr named=Open(Name(relative),true,false,true);try{Need(Same(identity,Read(named,true)));}finally{Win(CloseHandle(named));}return result;
    } finally {Win(CloseHandle(root));}
  }
  static bool Equal(Snapshot a,Snapshot b) {
    return a.identity.device==b.identity.device&&a.identity.inode==b.identity.inode&&a.bytes==b.bytes&&a.directories.SequenceEqual(b.directories)&&a.files.Count==b.files.Count&&a.files.Zip(b.files,(x,y)=>x.relative==y.relative&&x.bytes==y.bytes&&x.sha256==y.sha256).All(x=>x);
  }
  static Snapshot Publish(string source,string target,Snapshot expected) {
    Relative(source);Relative(target);Need(source!=""&&target!=""&&source!=target);
    string sourceParent=source.Contains('/')?source.Substring(0,source.LastIndexOf('/')):"";
    string targetParent=target.Contains('/')?target.Substring(0,target.LastIndexOf('/')):"";
    IntPtr from=Directory(sourceParent,false),to=Directory(targetParent,false),payload=Open(Name(source),true,true,true);
    try {Private(payload);Info before=Read(payload,true);Need(before.Volume==Read(from,true).Volume&&before.Volume==Read(to,true).Volume);Need(Attributes(Name(target),true)==0xffffffff);Need(Equal(Tree(source,false,false),expected));
      Win(MoveFileExW(Extended(Name(source)),Extended(Name(target)),8));FlushDirectory(from);FlushDirectory(to);
      Need(Attributes(Name(source),true)==0xffffffff);IntPtr final=Open(Name(target),true,false,true);try{Need(Same(before,Read(final,true)));Private(final);}finally{Win(CloseHandle(final));}
      Snapshot observed=Tree(target,false,false);Need(Equal(observed,expected));return observed;
    } finally {Win(CloseHandle(payload));}
  }
  static void Close() {int error=0;for(int i=Held.Count-1;i>=0;i--)if(!CloseHandle(Held[i])&&error==0)error=Marshal.GetLastWin32Error();Held.Clear();Directories.Clear();if(error!=0)throw new Win32Exception(error);}
  public static void Run() {
    try {
      for(Sequence=0;;Sequence++) {
        Checks=0;Step="input";var input=Input();
        if(Sequence==0){Guid guid;Nonce=Text(input,"nonce");Need(Guid.TryParse(Nonce,out guid));}Envelope(input);Step=Text(input,"op");object result=null;
        switch(Step) {
          case "open": Need(Sequence==0);Init(Text(input,"root"),Flag(input,"prepare"));break;
          case "prepare": Need(Root!=null);Prepare(Text(input,"root"),Text(input,"relative"));break;
          case "tree": result=Tree(Text(input,"path"),Flag(input,"sync"),true);break;
          case "sync": FlushDirectory(Directory(Text(input,"path"),false));break;
          case "publish": result=Publish(Text(input,"source"),Text(input,"target"),Json.ConvertToType<Snapshot>(input["expected"]));break;
          case "close": Close();Emit("result");return;
          default: throw new InvalidDataException();
        }
        Emit("result",result);
      }
    } catch(Exception error) {
      var native=error as Win32Exception;Emit("error",null,0,(Step??"setup")+":"+(error is BudgetError?"budget":native==null?"invalid":native.NativeErrorCode.ToString()));throw;
    } finally {Close();}
  }
}
'@
  [DacImportFileSet]::Run()
} catch { [Console]::Error.WriteLine('windows_import_file_set_failed'); exit 1 }
`

export type Lease = Awaited<ReturnType<typeof open>>

export async function open(root: string, prepare = false) {
  if (
    process.platform !== "win32" ||
    path.win32.normalize(process.env.SystemRoot ?? "").toLowerCase() !== "c:\\windows"
  )
    throw new Error("IMPORT_FILE_WINDOWS_UNAVAILABLE")
  const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const terminator = "C:\\Windows\\System32\\taskkill.exe"
  for (const filename of [executable, terminator])
    if (!(await fs.lstat(filename)).isFile() || (await fs.realpath(filename)).toLowerCase() !== filename.toLowerCase())
      throw new Error("IMPORT_FILE_WINDOWS_UNAVAILABLE")
  // Compress only this immutable source literal to stay below Windows' command-line bound.
  // No script, command or assembly comes from an operation request or a temporary file.
  const bootstrap =
    "$stream=[IO.MemoryStream]::new([Convert]::FromBase64String('" +
    gzipSync(Buffer.from(script, "utf8")).toString("base64") +
    "'));$gzip=[IO.Compression.GZipStream]::new($stream,[IO.Compression.CompressionMode]::Decompress);$reader=[IO.StreamReader]::new($gzip,[Text.Encoding]::UTF8);$fixed=$reader.ReadToEnd();$reader.Dispose();& ([ScriptBlock]::Create($fixed))"
  const encoded = Buffer.from(bootstrap, "utf16le").toString("base64")
  if (encoded.length > 28_000) throw new Error("IMPORT_FILE_WINDOWS_SCRIPT_BUDGET")
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const nonce = randomUUID()
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]()
  const state = {
    seq: 0,
    bytes: 0,
    busy: false,
    invalid: false,
    closing: false,
    stopping: undefined as Promise<void> | undefined,
  }
  const joined = new Promise<number | null>((resolve) => child.once("close", resolve))
  child.on("error", () => {
    state.invalid = true
  })
  child.stdin.on("error", () => {
    state.invalid = true
  })
  child.stderr.on("data", () => {
    /* OS diagnostics are never a receipt. */
  })
  const stop = () =>
    (state.stopping ??= (async () => {
      const deadline = Date.now() + 5_000
      const tree = { unknown: false }
      if (child.exitCode === null && child.signalCode === null) {
        const killer = spawn(terminator, ["/PID", String(child.pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        })
        const timer = setTimeout(() => killer.kill(), 3_000)
        const killed = await new Promise<boolean>((resolve) => {
          killer.once("error", () => resolve(false))
          killer.once("close", (code) => resolve(code === 0))
        }).finally(() => clearTimeout(timer))
        if (!killed && child.exitCode === null && child.signalCode === null) {
          tree.unknown = true
          child.kill()
        }
      }
      const timeout = Promise.withResolvers<never>()
      const timer = setTimeout(
        () => timeout.reject(new Error("IMPORT_FILE_WINDOWS_CLEANUP_UNKNOWN")),
        Math.max(1, deadline - Date.now()),
      )
      try {
        await Promise.race([joined, timeout.promise])
        if (tree.unknown) throw new Error("IMPORT_FILE_WINDOWS_CLEANUP_UNKNOWN")
      } finally {
        clearTimeout(timer)
      }
    })())
  child.stdout.on("data", (chunk: Buffer) => {
    state.bytes += chunk.length
    if (state.bytes <= 8_388_608) return
    state.invalid = true
    void stop().catch(() => undefined)
  })
  const relative = (filename: string) => {
    const value = path.win32.relative(root, filename).split(path.win32.sep).join("/")
    if (value.split("/").includes("..") || path.win32.isAbsolute(value) || /[\\:\u0000-\u001f\u007f]/.test(value))
      throw new Error("IMPORT_FILE_TARGET_INVALID: Windows operation escaped its original job root")
    return value
  }
  const request = async (
    op: string,
    input: Record<string, unknown> = {},
    checkpoint: () => Promise<void> = async () => {},
  ) => {
    if (state.invalid || state.busy || state.closing) throw new Error("IMPORT_FILE_WINDOWS_UNAVAILABLE")
    state.busy = true
    state.bytes = 0
    const seq = state.seq++
    const timeout = Promise.withResolvers<never>()
    const timer = setTimeout(() => timeout.reject(new Error("IMPORT_FILE_WINDOWS_TIMEOUT")), 30_000)
    try {
      child.stdin.write(JSON.stringify({ protocol: 1, nonce, seq, op, ...input }) + "\n")
      for (let index = 1; ; index++) {
        const next = await Promise.race([lines.next(), timeout.promise])
        if (next.done || state.invalid) throw new Error("IMPORT_FILE_WINDOWS_RECEIPT_UNKNOWN")
        const frame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame), { onExcessProperty: "error" })(next.value)
        if (frame.nonce !== nonce || frame.seq !== seq) throw new Error("IMPORT_FILE_WINDOWS_RECEIPT_UNKNOWN")
        if (frame.phase === "error") {
          if (frame.code?.endsWith(":budget"))
            throw new Error("IMPORT_FILE_BUDGET_EXCEEDED: complete private file-set budget")
          throw new Error("IMPORT_FILE_WINDOWS_FAILED: " + (frame.code?.slice(0, 128) ?? "unknown"))
        }
        if (frame.phase === "result") return frame.value
        if (frame.index !== index || index > 10_000) throw new Error("IMPORT_FILE_WINDOWS_RECEIPT_UNKNOWN")
        await Promise.race([checkpoint(), timeout.promise])
        child.stdin.write(JSON.stringify({ protocol: 1, nonce, seq, phase: "continue", index }) + "\n")
      }
    } catch (error) {
      state.invalid = true
      await stop()
      throw error
    } finally {
      clearTimeout(timer)
      state.busy = false
    }
  }
  const close = async () => {
    if (state.closing) return
    if (state.invalid) {
      state.closing = true
      await stop()
      return
    }
    try {
      await request("close")
      state.closing = true
      child.stdin.end()
      const timeout = Promise.withResolvers<never>()
      const timer = setTimeout(() => timeout.reject(new Error("IMPORT_FILE_WINDOWS_CLEANUP_UNKNOWN")), 5_000)
      try {
        if ((await Promise.race([joined, timeout.promise])) !== 0)
          throw new Error("IMPORT_FILE_WINDOWS_CLEANUP_UNKNOWN")
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      state.invalid = true
      await stop()
      throw error
    }
  }
  try {
    await request("open", { root, prepare })
  } catch (error) {
    await close()
    throw error
  }
  return {
    async prepare(directory: string, ref: string) {
      await request("prepare", { root: relative(directory), relative: ref })
    },
    async tree(directory: string, checkpoint: () => Promise<void>, sync: boolean) {
      return Schema.decodeUnknownSync(Tree)(await request("tree", { path: relative(directory), sync }, checkpoint))
    },
    async sync(directory: string) {
      await request("sync", { path: relative(directory) })
    },
    async publish(source: string, target: string, expected: Tree) {
      return Schema.decodeUnknownSync(Tree)(
        await request("publish", { source: relative(source), target: relative(target), expected }),
      )
    },
    [Symbol.asyncDispose]: close,
  }
}
