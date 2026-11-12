; Devis-Setup.exe additions. electron-builder includes this file (build/installer.nsh) in both the
; installer and its uninstaller.
;
; Before Setup replaces or removes files, stop a running Devis the way scripts\deploy-desktop.ps1
; does, with build\stop-devis.ps1, instead of electron-builder's own check, which force-kills
; everything in the install folder: the background service too, with its work in flight.

; electron-builder's check needs these, and only declares them when there's no custom check.
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  InitPluginsDir
  File "/oname=$PLUGINSDIR\stop-devis.ps1" "${BUILD_RESOURCES_DIR}\stop-devis.ps1"
  ; A silent run (a script, an update) waits a while for work in flight; a visible one asks.
  StrCpy $R8 ""
  ${If} ${Silent}
    StrCpy $R8 "-WaitMinutes 10"
  ${EndIf}

  devis_stop:
    nsExec::ExecToStack `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-devis.ps1" -InstallDir "$INSTDIR" $R8`
    Pop $R0
    Pop $R1
    devis_trim:
      StrCpy $R2 $R1 1 -1
      ${If} $R2 == "$\n"
      ${OrIf} $R2 == "$\r"
        StrCpy $R1 $R1 -1
        Goto devis_trim
      ${EndIf}
    ${If} $R0 == 0
      Goto devis_stopped
    ${EndIf}
    ${If} $R0 != 2
      ; The script couldn't stop Devis, or couldn't run at all: electron-builder's check, which asks first.
      !insertmacro IS_POWERSHELL_AVAILABLE
      !insertmacro _CHECK_APP_RUNNING
      Goto devis_stopped
    ${EndIf}
    ${If} ${Silent}
      SetErrorLevel 2
      Quit
    ${EndIf}
    MessageBox MB_YESNOCANCEL|MB_ICONEXCLAMATION "Devis is still working on:$\r$\n$\r$\n$R1$\r$\n$\r$\nYes stops it now. That work picks up again the next time Devis opens.$\r$\nNo waits for it to finish first.$\r$\nCancel leaves Devis as it is." IDYES devis_force IDNO devis_wait
    Quit

  devis_force:
    StrCpy $R8 "-Force"
    Goto devis_stop

  devis_wait:
    StrCpy $R8 "-WaitMinutes 60"
    Goto devis_stop

  devis_stopped:
!macroend
