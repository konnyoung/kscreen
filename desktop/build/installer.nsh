; Per-machine install (UAC): registers the SYSTEM task that gives kScreen REALTIME GPU priority
; while sharing (see kscreen-audio.cs, InstallGpuTask). Runs from Program Files, which only admins
; can write, so the elevated task can't be pointed at anything else.
!macro customInstall
  nsExec::Exec '"$INSTDIR\resources\kscreen-audio.exe" --install-gpu-task'
!macroend

!macro customUnInstall
  nsExec::Exec '"$INSTDIR\resources\kscreen-audio.exe" --remove-gpu-task'
!macroend
