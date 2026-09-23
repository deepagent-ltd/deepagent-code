; DeepAgent Code NSIS customization (electron-builder `nsis.include`, resolved
; against buildResources). Manages the *user* PATH only — never the machine
; PATH — following the VSCode installer convention: a per-user install needs no
; elevation, and per-user shells only consult HKCU\Environment anyway.
;
; Everything here uses core NSIS + LogicLib + WinMessages only (no bundled
; plugins), preserves the REG_EXPAND_SZ value type Windows expects for Path,
; and broadcasts WM_SETTINGCHANGE so a new terminal sees the change without a
; reboot. The runtime side of this contract lives in
; packages/desktop/src/main/win-env.ts (D-W3).

!include "LogicLib.nsh"
!include "WinMessages.nsh"

!macro RemovePathSegment UN
; Stack: <path> <segment> -> <path without the segment>, empty segments dropped.
; NSIS has no string replace builtin, so walk the ;-delimited segments by hand.
Function ${UN}RemovePathSegment
  Exch $R9 ; segment to remove; stack top is now the path
  Exch $R8 ; path; stack top is now stale $R8 content, popped in the epilogue
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
  Pop $R9 ; discard the stale $R8 slot
  Push $R8 ; return the cleaned path
FunctionEnd
!macroend
!insertmacro RemovePathSegment ""
!insertmacro RemovePathSegment "un."

!macro WriteUserPath
  ; $R0 = new user Path value. REG_EXPAND_SZ keeps %VAR% references expandable
  ; (the machine default type for Path) even though we write literal paths.
  WriteRegExpandStr HKCU "Environment" "Path" "$R0"
  ; Tell Explorer (and every process it launches) that the environment changed.
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customInstall
  ClearErrors
  ReadRegStr $R1 HKCU "Environment" "Path"
  ${If} ${Errors}
    StrCpy $R1 ""
  ${EndIf}
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
  ${If} ${Errors}
    StrCpy $R1 ""
  ${EndIf}
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
!macroend
