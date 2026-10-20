; Compiles the actual installer include and exercises its PATH helper without
; invoking customInstall/customUnInstall or writing the registry.
; Pass PROBE_INCLUDE, PROBE_OUTPUT and PROBE_RESULTS via makensis /D options.
Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
!ifndef PROBE_INCLUDE
 !error "Define PROBE_INCLUDE as the actual resources/installer.nsh path"
!endif
!ifndef PROBE_OUTPUT
 !error "Define PROBE_OUTPUT as an isolated probe executable path"
!endif
!ifndef PROBE_RESULTS
 !error "Define PROBE_RESULTS as an isolated result text path"
!endif
OutFile "${PROBE_OUTPUT}"
!define INSTALL_REGISTRY_KEY "Software\DeepAgentCodeNSISPathProbe"
!include "${PROBE_INCLUDE}"
!insertmacro customHeader
!macro Case NAME INPUT TARGET EXPECTED
 StrCpy $R4 "r4-preserved"
 StrCpy $R5 "r5-preserved"
 StrCpy $R6 "r6-preserved"
 StrCpy $R7 "r7-preserved"
 StrCpy $R8 "r8-preserved"
 StrCpy $R9 "r9-preserved"
 Push "stack-sentinel"
 Push "${INPUT}"
 Push "${TARGET}"
 Call RemovePathSegment
 Pop $R0
 Pop $R1
 ${If} $R0 != "${EXPECTED}"
 ${OrIf} $R1 != "stack-sentinel"
 ${OrIf} $R4 != "r4-preserved"
 ${OrIf} $R5 != "r5-preserved"
 ${OrIf} $R6 != "r6-preserved"
 ${OrIf} $R7 != "r7-preserved"
 ${OrIf} $R8 != "r8-preserved"
 ${OrIf} $R9 != "r9-preserved"
  IntOp $1 $1 + 1
  FileWrite $0 "${NAME}|FAIL|result=$R0|stack=$R1|r8=$R8|r9=$R9$\r$\n"
 ${Else}
  FileWrite $0 "${NAME}|PASS$\r$\n"
 ${EndIf}
!macroend
Section
 FileOpen $0 "${PROBE_RESULTS}" w
 StrCpy $1 0
 !insertmacro Case "preserve-other-segments" "C:\keep;D:\drop;E:\keep" "D:\drop" "C:\keep;E:\keep"
 !insertmacro Case "missing-target" "C:\keep;E:\keep" "D:\drop" "C:\keep;E:\keep"
 !insertmacro Case "only-target" "D:\drop" "D:\drop" ""
 !insertmacro Case "empty-path" "" "D:\drop" ""
 !insertmacro Case "duplicate-targets" "C:\keep;D:\drop;D:\drop;E:\keep" "D:\drop" "C:\keep;E:\keep"
 !insertmacro Case "empty-segments" ";C:\keep;;E:\keep;" "D:\drop" "C:\keep;E:\keep"
 !insertmacro Case "preserve-prefix-and-case" "C:\keep;D:\drop-extra;d:\DROP;E:\keep" "D:\drop" "C:\keep;D:\drop-extra;E:\keep"
 FileWrite $0 "failures=$1$\r$\n"
 FileClose $0
 ${If} $1 == 0
  SetErrorLevel 0
 ${Else}
  SetErrorLevel 1
 ${EndIf}
SectionEnd
