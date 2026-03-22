import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { isMac, isWindows } from "@/lib/platform";

const execAsync = promisify(exec);

export async function GET() {
  if (isWindows) {
    // On Windows, use PowerShell to show a folder picker dialog
    try {
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select your code directory"
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;
      const { stdout } = await execAsync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, {
        timeout: 60000,
      });

      const folderPath = stdout.trim();

      if (!folderPath) {
        return NextResponse.json({ cancelled: true });
      }

      return NextResponse.json({ path: folderPath });
    } catch {
      // User cancelled the dialog
      return NextResponse.json({ cancelled: true });
    }
  }

  if (!isMac) {
    return NextResponse.json({ error: "Folder picker not supported on this platform" }, { status: 400 });
  }

  try {
    const script = `
tell application "System Events"
  activate
end tell
set chosenFolder to choose folder with prompt "Select your code directory"
return POSIX path of chosenFolder`;

    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 60000 });

    const folderPath = stdout.trim().replace(/\/$/, "");

    if (!folderPath) {
      return NextResponse.json({ error: "No folder selected" }, { status: 400 });
    }

    return NextResponse.json({ path: folderPath });
  } catch {
    // User cancelled the dialog
    return NextResponse.json({ cancelled: true });
  }
}
