; DeepAgent Code NSIS customization (electron-builder `nsis.include`, resolved
; against buildResources). Manages the *user* PATH only — never the machine
; PATH — following the VSCode installer convention: a per-user install needs no
; elevation, and per-user shells only consult HKCU\Environment anyway.
;
; Everything here uses NSIS's bundled System plugin + LogicLib + WinMessages.
; Successful installs write REG_EXPAND_SZ; failed upgrades restore the original
; string type and value. WM_SETTINGCHANGE lets new terminals see changes without
; a reboot. The runtime side of this contract lives in
; packages/desktop/src/main/win-env.ts (D-W3).

!include "LogicLib.nsh"
!include "WinMessages.nsh"

!ifndef BUILD_UNINSTALLER
Var UserPathBeforeUpgrade
Var UserInstallBeforeUpgrade
Var UserPathSnapshotCaptured
Var UserPathBeforeUpgradeExists
Var UserPathBeforeUpgradeType
Var UserUninstallBeforeUpgrade
!endif

!macro customHeader
!ifndef BUILD_UNINSTALLER
; This section runs immediately before electron-builder's main install section.
; Released 2.0.4 uninstallers can overwrite PATH during an upgrade, so retain the
; install-time value before electron-builder invokes the old uninstaller.
Section -CaptureUserPath
  StrCpy $UserPathSnapshotCaptured "0"
  StrCpy $UserPathBeforeUpgrade ""
  StrCpy $UserPathBeforeUpgradeExists "0"
  StrCpy $UserPathBeforeUpgradeType "-1"
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $2 "0"
  StrCpy $3 "0"
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "Environment", i 0, i 0x1, *p .r0) i.r1'
  ${If} $1 == 0
    System::Call 'advapi32::RegQueryValueExW(p r0, w "Path", p 0, *i .r2, p 0, *i .r3) i.r1'
    System::Call 'advapi32::RegCloseKey(p r0)'
  ${EndIf}
  ${If} $1 == 2
    ; ERROR_FILE_NOT_FOUND is the only read failure that means no original Path.
    StrCpy $UserPathBeforeUpgradeType "0"
  ${ElseIf} $1 == 0
    ${If} $2 == 1
    ${OrIf} $2 == 2
      ; Query the byte length before ReadRegStr can truncate an oversized value.
      IntOp $0 ${NSIS_MAX_STRLEN} * 2
      ${If} $3 <= $0
        ClearErrors
        ReadRegStr $UserPathBeforeUpgrade HKCU "Environment" "Path"
        ${IfNot} ${Errors}
          StrLen $0 $UserPathBeforeUpgrade
          IntOp $0 $0 + 1
          IntOp $0 $0 * 2
          ${If} $0 == $3
            StrCpy $UserPathBeforeUpgradeType "$2"
            StrCpy $UserPathBeforeUpgradeExists "1"
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $UserPathBeforeUpgradeType == "-1"
    DetailPrint "User PATH snapshot rejected (registry status $1, type $2, bytes $3)."
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  ${If} $UserPathBeforeUpgradeType == "-1"
    MessageBox MB_OK|MB_ICONSTOP "Unable to safely preserve the user PATH. Installation stopped before removing the existing application." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  ClearErrors
  ReadRegStr $UserInstallBeforeUpgrade HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} ${Errors}
    StrCpy $UserInstallBeforeUpgrade ""
  ${EndIf}
  ClearErrors
  StrCpy $UserUninstallBeforeUpgrade ""
  ReadRegStr $UserUninstallBeforeUpgrade HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${If} $UserUninstallBeforeUpgrade == ""
      ClearErrors
      ReadRegStr $UserUninstallBeforeUpgrade HKCU "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
    ${EndIf}
  !endif
  ClearErrors
  StrCpy $UserPathSnapshotCaptured "1"
SectionEnd
!endif
!macroend

!macro RemovePathSegment UN
; Stack: <path> <segment> -> <path without the segment>, empty segments dropped.
; NSIS has no string replace builtin, so walk the ;-delimited segments by hand.
Function ${UN}RemovePathSegment
  Exch $R9 ; segment to remove; save the caller's $R9 on the stack
  Exch 1 ; expose the path beneath the saved $R9
  Exch $R8 ; path; save the caller's $R8 above the saved $R9
  Push $R7 ; rebuilt path (always grows with a trailing ';')
  Push $R6 ; unprocessed remainder (original path + terminator ';')
  Push $R5 ; segment being accumulated
  Push $R4 ; current character
  StrCpy $R7 ""
  StrCpy $R6 "$R8;"
  StrCpy $R5 ""
loop:
  StrCpy $R4 $R6 1
  StrCmp $R4 "" done
  StrCpy $R6 $R6 "" 1
  StrCmp $R4 ";" segment_end
  StrCpy $R5 "$R5$R4"
  Goto loop
segment_end:
  ; Skip the target segment; also drop empty segments (path normalization —
  ; Windows ignores them, so removing them cannot change behavior).
  StrCmp $R5 "$R9" segment_reset
  StrCmp $R5 "" segment_reset
  StrCpy $R7 "$R7$R5;"
segment_reset:
  StrCpy $R5 ""
  Goto loop
done:
  ${If} $R7 != ""
    StrLen $R4 $R7
    IntOp $R4 $R4 - 1
    StrCpy $R7 $R7 $R4 ; strip the trailing ';'
  ${EndIf}
  StrCpy $R8 $R7 ; result
  Pop $R4
  Pop $R5
  Pop $R6
  Pop $R7
  Exch $R8 ; return the result while restoring the caller's $R8
  Exch 1
  Pop $R9 ; restore the caller's $R9, leaving only the result
FunctionEnd
!macroend
; electron-builder compiles this include twice (installer pass + BUILD_UNINSTALLER
; pass) and treats makensis warnings as errors. Each pass references only its own
; function variant, so emit just that one — an unreferenced variant fails the
; build with warning 6010.
!ifdef BUILD_UNINSTALLER
  !insertmacro RemovePathSegment "un."
!else
  !insertmacro RemovePathSegment ""
!endif

!macro WriteUserPath
  ; $R0 = new user Path value. REG_EXPAND_SZ keeps %VAR% references expandable
  ; (the machine default type for Path) even though we write literal paths.
  WriteRegExpandStr HKCU "Environment" "Path" "$R0"
  ; Tell Explorer (and every process it launches) that the environment changed.
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstallCheck
  ; electron-builder calls this immediately after the old uninstaller returns,
  ; before its failure Quit and before extracting the new application. Restoring
  ; here also protects PATH when a later install step fails, without callbacks.
  Push $R0
  Push $R1
  ${If} ${Errors}
    StrCpy $R1 "1"
  ${Else}
    StrCpy $R1 "0"
  ${EndIf}
  ${If} $UserPathSnapshotCaptured == "1"
  ${AndIf} $UserUninstallBeforeUpgrade != ""
    ClearErrors
    ${If} $UserPathBeforeUpgradeExists == "1"
      ${If} $UserPathBeforeUpgradeType == "1"
        WriteRegStr HKCU "Environment" "Path" "$UserPathBeforeUpgrade"
      ${ElseIf} $UserPathBeforeUpgradeType == "2"
        WriteRegExpandStr HKCU "Environment" "Path" "$UserPathBeforeUpgrade"
      ${EndIf}
    ${Else}
      DeleteRegValue HKCU "Environment" "Path"
      ${If} ${Errors}
        ; Deleting an already-absent value is successful restoration too. Query
        ; existence without interpreting a type/read failure as a missing value.
        Push $0
        Push $1
        System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "Environment", i 0, i 0x1, *p .r0) i.r1'
        ${If} $1 == 0
          System::Call 'advapi32::RegQueryValueExW(p r0, w "Path", p 0, p 0, p 0, p 0) i.r1'
          System::Call 'advapi32::RegCloseKey(p r0)'
        ${EndIf}
        ${If} $1 == 2
          ClearErrors
        ${Else}
          SetErrors
        ${EndIf}
        Pop $1
        Pop $0
      ${EndIf}
    ${EndIf}
    ${If} ${Errors}
      Pop $R1
      Pop $R0
      DetailPrint "Unable to restore the user PATH after removing the existing application."
      MessageBox MB_OK|MB_ICONSTOP "Unable to restore the user PATH. Installation stopped." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
  ${If} $R1 == "1"
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $R1
  Pop $R0

  ; Defining this hook replaces upstream's default check (which then Returns).
  ; Preserve its original launch-error and nonzero-exit behavior exactly.
  IfErrors 0 +3
  DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  Return
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customInstall
  Push $UserPathBeforeUpgrade
  Push $UserInstallBeforeUpgrade
  Call RemovePathSegment
  Pop $R1
  Push $R1
  Push "$INSTDIR"
  Call RemovePathSegment
  Pop $R0 ; existing user Path minus $INSTDIR (and minus empty segments)
  ${If} $R0 == ""
    StrCpy $R0 "$INSTDIR"
  ${Else}
    StrCpy $R0 "$R0;$INSTDIR"
  ${EndIf}
  !insertmacro WriteUserPath
!macroend

!macro customUnInstall
  ClearErrors
  ReadRegStr $R1 HKCU "Environment" "Path"
  ${IfNot} ${Errors}
    Push $R1
    Push "$INSTDIR"
    Call un.RemovePathSegment
    Pop $R0
    ${If} $R0 == ""
      DeleteRegValue HKCU "Environment" "Path"
      SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${Else}
      !insertmacro WriteUserPath
    ${EndIf}
  ${Else}
    DetailPrint "User PATH could not be read safely; PATH left unchanged."
  ${EndIf}
!macroend
