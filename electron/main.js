const { app, BrowserWindow, shell, utilityProcess } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const net = require("net");
const http = require("http");

const PORT = 3200;
let nextProcess = null;

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

// Electron apps launched from Finder/dock get a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
// Augment it so child processes can find tools like `gh` installed via Homebrew or other managers.
if (isMac) {
  const EXTRA_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/homebrew/sbin"];
  if (process.env.PATH) {
    const existing = process.env.PATH.split(":");
    for (const p of EXTRA_PATHS) {
      if (!existing.includes(p)) existing.push(p);
    }
    process.env.PATH = existing.join(":");
  } else {
    process.env.PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", ...EXTRA_PATHS].join(":");
  }
} else if (isWindows) {
  // On Windows, ensure System32 is in PATH for wsl.exe and wt.exe
  const system32 = path.join(process.env.SYSTEMROOT || "C:\\Windows", "System32");
  if (process.env.PATH) {
    const existing = process.env.PATH.split(";");
    if (!existing.some((p) => p.toLowerCase() === system32.toLowerCase())) {
      existing.push(system32);
    }
    process.env.PATH = existing.join(";");
  }
}

let mainWindow = null;
let isQuitting = false;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function getNextAppDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "next-app");
  }
  return path.join(__dirname, "..");
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

function checkServerReady(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/`, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function startNextServer() {
  const appDir = getNextAppDir();

  if (app.isPackaged) {
    // Use Electron's bundled Node.js via utilityProcess -- no system Node required
    const serverPath = path.join(appDir, "server.js");
    console.log(`Starting standalone server via utilityProcess: ${serverPath}`);

    nextProcess = utilityProcess.fork(serverPath, [], {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOSTNAME: "localhost",
        NODE_ENV: "production",
      },
      stdio: "pipe",
    });

    nextProcess.stdout?.on("data", (data) => {
      try {
        process.stdout.write(`[next] ${data}`);
      } catch {
        /* ignore EPIPE */
      }
    });

    nextProcess.stderr?.on("data", (data) => {
      try {
        process.stderr.write(`[next] ${data}`);
      } catch {
        /* ignore EPIPE */
      }
    });

    nextProcess.on("exit", (code) => {
      nextProcess = null;
      if (!isQuitting) {
        console.error(`Next.js server exited with code ${code}`);
      }
    });
  } else {
    const nextBin = path.join(appDir, "node_modules", ".bin", isWindows ? "next.cmd" : "next");
    nextProcess = spawn(nextBin, ["dev", "-p", String(PORT)], {
      cwd: appDir,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
    });

    nextProcess.stdout?.on("data", (data) => {
      try {
        process.stdout.write(`[next] ${data}`);
      } catch {
        /* ignore EPIPE */
      }
    });

    nextProcess.stderr?.on("data", (data) => {
      try {
        process.stderr.write(`[next] ${data}`);
      } catch {
        /* ignore EPIPE */
      }
    });

    nextProcess.on("error", (err) => {
      console.error("Failed to start Next.js server:", err.message);
    });

    nextProcess.on("close", (code) => {
      nextProcess = null;
      if (!isQuitting) {
        console.error(`Next.js server exited with code ${code}`);
      }
    });
  }
}

async function waitForServer(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const ready = await checkServerReady(PORT);
    if (ready) return true;
    // If the process died, don't keep waiting
    if (nextProcess === null) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function createWindow() {
  const windowOptions = {
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#050508",
    icon: path.join(__dirname, "..", "public", "icon.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  };

  // macOS-specific title bar styling
  if (isMac) {
    windowOptions.titleBarStyle = "hiddenInset";
    windowOptions.trafficLightPosition = { x: 16, y: 16 };
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("ready", async () => {
  // Check if server is already running
  const alreadyRunning = await checkServerReady(PORT);

  if (!alreadyRunning) {
    await startNextServer();
    console.log("Waiting for Next.js server to be ready...");
    const ready = await waitForServer();
    if (!ready) {
      console.error("Next.js server failed to start. Quitting.");
      app.quit();
      return;
    }
    console.log("Next.js server is ready.");
  }

  createWindow();
});

app.on("window-all-closed", () => {
  // On macOS, apps typically stay open until Cmd+Q
  if (!isMac) {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  if (nextProcess) {
    nextProcess.kill();
    nextProcess = null;
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
