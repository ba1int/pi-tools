import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Appearance = "light" | "dark";

const execFileAsync = promisify(execFile);

function isWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

async function detectAppearance(): Promise<Appearance | undefined> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/defaults",
        ["read", "-g", "AppleInterfaceStyle"],
        { timeout: 1500 },
      );
      return stdout.trim().toLowerCase() === "dark" ? "dark" : "light";
    } catch {
      // AppleInterfaceStyle is absent while macOS is using its light appearance.
      return "light";
    }
  }

  if (process.platform === "linux" && isWsl()) {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[int](Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize').AppsUseLightTheme",
        ],
        { timeout: 3000 },
      );
      const value = stdout.trim();
      if (value === "1") return "light";
      if (value === "0") return "dark";
    } catch {
      return undefined;
    }
  }

  return undefined;
}

async function syncZellij(appearance: Appearance): Promise<boolean> {
  if (!process.env.ZELLIJ && !process.env.ZELLIJ_SESSION_NAME) return false;
  try {
    await execFileAsync(
      "zellij",
      ["action", appearance === "light" ? "set-light-theme" : "set-dark-theme"],
      { timeout: 1500 },
    );
    return true;
  } catch {
    // Theme sync is cosmetic and must never disturb the Pi session.
    return false;
  }
}

function applyPiTheme(ctx: ExtensionContext, appearance: Appearance): boolean {
  const themeName = appearance === "light" ? "protocol-paper" : "protocol-ink";
  if (ctx.ui.theme.name === themeName) return true;
  const selectedTheme = ctx.ui.getTheme(themeName);
  if (!selectedTheme) return false;

  // Passing a Theme instance changes the live UI without replacing the paired
  // protocol-paper/protocol-ink setting in settings.json.
  return ctx.ui.setTheme(selectedTheme).success;
}

export default function appearanceSync(pi: ExtensionAPI) {
  let interval: ReturnType<typeof setInterval> | undefined;
  let zellijAppearance: Appearance | undefined;
  let syncInProgress = false;

  const sync = async (ctx: ExtensionContext) => {
    if (syncInProgress) return;
    syncInProgress = true;
    try {
      const appearance = await detectAppearance();
      if (!appearance) return;
      if (zellijAppearance !== appearance && await syncZellij(appearance)) {
        zellijAppearance = appearance;
      }
      if (!applyPiTheme(ctx, appearance)) return;
    } finally {
      syncInProgress = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await sync(ctx);
    const intervalMs = process.platform === "darwin" ? 2000 : isWsl() ? 10000 : 0;
    if (intervalMs > 0) interval = setInterval(() => void sync(ctx), intervalMs);
  });

  pi.on("session_shutdown", () => {
    if (interval) clearInterval(interval);
    interval = undefined;
  });
}
