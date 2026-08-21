Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
WshShell.Run "cmd /c """ & "c:\Users\conta\OneDrive\Documents\WebApps\nimbus-drive\scripts\nimbus-autostart.bat" & """", 0, False
