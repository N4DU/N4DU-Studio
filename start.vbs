' N4DU Studio - silent launcher for Windows (double-click).
'
' Why this exists alongside start.bat: a .bat file cannot avoid showing a
' console. Windows creates one for cmd.exe before the first line of the
' script runs, so the best a batch file can do is close it quickly. This
' runs through the Windows Script Host instead, which opens no window at
' all - the app is the only thing that appears on screen.
'
' It does nothing clever: finds the windowless Python build, runs main.py
' next to this file, and passes on any files dragged onto it.

Option Explicit

Dim shell, fso, here, script, py, args, i, quoted
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "main.py")

If Not fso.FileExists(script) Then
    MsgBox "main.py is not next to this launcher." & vbCrLf & vbCrLf & _
           "Keep start.vbs in the same folder as the rest of N4DU Studio.", _
           vbExclamation, "N4DU Studio"
    WScript.Quit 1
End If

' pythonw.exe first: it is the build with no console attached. pyw.exe is
' the launcher's equivalent. Only if neither exists do we fall back to a
' console build - and main.py hides that console itself on startup.
py = ""
For Each i In Array("pythonw.exe", "pyw.exe", "python.exe", "py.exe")
    If py = "" Then
        On Error Resume Next
        Dim found
        found = shell.Exec("cmd /c where " & i).StdOut.ReadLine()
        On Error GoTo 0
        If found <> "" Then py = found
    End If
Next

If py = "" Then
    MsgBox "Python was not found on this machine." & vbCrLf & vbCrLf & _
           "Install it from https://www.python.org/downloads/" & vbCrLf & _
           "and tick ""Add Python to PATH"" during setup.", _
           vbExclamation, "N4DU Studio"
    WScript.Quit 1
End If

' Anything dropped onto this launcher is handed straight to --open, which
' takes as many paths as it is given.
quoted = """" & py & """ """ & script & """"
If WScript.Arguments.Count > 0 Then
    quoted = quoted & " --open"
    For i = 0 To WScript.Arguments.Count - 1
        quoted = quoted & " """ & WScript.Arguments(i) & """"
    Next
End If

' 0 = no window, False = do not wait for it to finish.
shell.CurrentDirectory = here
shell.Run quoted, 0, False
