; STMCL 安装器自定义清理
; 只允许当前用户安装（package.json 里 allowElevation=false），不请求管理员权限。

!macro customInstallMode
  ; 强制仅当前用户安装，跳过“为所有用户/仅我”选择页，不请求管理员权限
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  ; 清理旧品牌残留（SWUSTMCL 时代的 exe 与卸载器）
  Delete "$INSTDIR\SWUSTMCL.exe"
  Delete "$INSTDIR\Uninstall SWUSTMCL.exe"
!macroend

!macro customUnInstall
  ; 交互式卸载时询问是否同时删除游戏数据；默认保留，避免误删存档
  IfSilent stmclUninstallKeepData
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除游戏数据与启动器配置？$\r$\n$\r$\n会删除：$\r$\n$INSTDIR\.minecraft$\r$\n$INSTDIR\userdata$\r$\n$\r$\n选择“否”将保留存档、模组和账户配置。" IDNO stmclUninstallKeepData
  RMDir /r "$INSTDIR\.minecraft"
  RMDir /r "$INSTDIR\userdata"
  stmclUninstallKeepData:
!macroend
