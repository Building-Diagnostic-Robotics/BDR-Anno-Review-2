!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current
  RMDir /r "$LOCALAPPDATA\Temp\bdr-anno-review-drop-*"
!macroend
