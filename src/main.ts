import electron, {
  IpcMainEvent,
  Event,
  WebContentsWillNavigateEventParams,
} from "electron";
import { Editor, MarkdownView, Notice, Plugin } from "obsidian";
import {
  TokenResponse,
  fetchToken,
  fetchCurrentSong,
  redirectUri,
  buildAuthUrlAndVerifier,
  Song,
} from "spotifyAPI";
import {
  getToken,
  hasNotifiedPublicAvailability,
  setHasNotifiedPublicAvailability,
  storeToken,
} from "tokenStorage";
import {
  DEFAULT_SETTINGS,
  ObsidianSpotifyPluginSettings,
  SettingTab,
} from "settings";
//import { fetchAudioFeatures } from "spotifyAPI";

export default class ObsidianSpotifyPlugin extends Plugin {
  settings: ObsidianSpotifyPluginSettings;

  // Inspired by:
  // - https://stackoverflow.com/questions/73636861/electron-how-to-get-an-auth-token-from-browserwindow-to-the-main-electron-app
  // - https://authguidance.com/desktop-apps-overview/
  // - https://stackoverflow.com/questions/64530295/what-redirect-uri-should-i-use-for-an-authorization-call-used-in-an-electron-app
  openSpotifyAuthModal = (onComplete?: () => void) => {
    // Build the authorization URL
    const [authUrl, verifier] = buildAuthUrlAndVerifier();

    // Open a window to that url
    // @ts-ignore remote is available in obsidian currently
    const authWindow = new electron.remote.BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        webSecurity: false,
      },
    });
    authWindow.loadURL(authUrl);
    authWindow.show();

    // The channel through which the auth window will communicate with the main process
    const accessTokenChannel = "access-token-response";

    // If the user accepts, grab the auth code, exchange for an access token, and send that to the main window
    // All other navigations are ignored
    authWindow.webContents.on(
      "will-navigate",
      async (event: Event<WebContentsWillNavigateEventParams>) => {
        const url = new URL(event.url);
        // Ignore all navigations that are not clicking the accept button in the auth flow
        if (!url.href.startsWith(redirectUri)) {
          // TODO: Would it be better to check if url.protocol === "obsidian:"?
          return;
        }

        // Otherwise the user has accepted, grab the code and a potential error
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        // Set up a helper to issue a notification, console error, and remove the listener on accessTokenChannel
        const bail = (error: string) => {
          new Notice("❌ There was an issue signing you in");
          console.error("Error encountered during auth flow: " + error);
          // @ts-ignore remote is available in obsidian currently
          electron.remote.ipcMain.removeAllListeners(accessTokenChannel);
          authWindow.destroy();
        };

        // If we didn't get an auth code, error out
        if (error) {
          bail(error);
          return;
        }

        // If we didn't get an auth code, error out
        if (code === null) {
          bail("code not present");
          return;
        }

        // Exchange auth code for an access token response
        const tokenResponse = await fetchToken(code, verifier, redirectUri);

        // If there was an issue fetching the token, error out
        if (!tokenResponse) {
          bail("issue fetching token");
          return;
        }

        // Send access token and related information to main window
        electron.ipcRenderer.send(accessTokenChannel, tokenResponse);
      }
    );

    // @ts-ignore remote is available in obsidian currently
    electron.remote.ipcMain.once(
      accessTokenChannel,
      (event: IpcMainEvent, token: TokenResponse) => {
        storeToken(token);
        authWindow.destroy();
        onComplete?.();
      }
    );
  };

  /** This is an `editorCallback` function which fetches the current song an inserts it into the editor. */
  insertSongLink = async (editor: Editor, view: MarkdownView) => {
    const token = await getToken();

    // Handle the case where the function is used without first having logged in
    if (token === undefined) {
      new Notice("🎵 Connect Spotify in settings first");
      this.openSettingsPage();
      return;
    }

    const song = await fetchCurrentSong(token.access_token);
    // TODO: Add some kind of loading state for UX clarity

    // Handle case of no song playing
    if (song === undefined) {
      new Notice("❌ No song playing");
      return;
    }

    const link = this.buildSongLink(song);

    // If we get here, we are good to insert the song link
    editor.replaceSelection(link);
    new Notice("✅ Added song link");
  };

  /** Build a MD link to the song including attribution */
  buildSongLink = (song: Song) => {
    return `[${song.name}](${song.link})`;
  };

  /** Open Spotify Links settings page */
  openSettingsPage = () => {
    // We use optional chaining to handle the private Obsidian API carefully
    // Unofficial types come from https://github.com/Fevol/obsidian-typings
    this.app.setting?.open?.();
    this.app.setting?.openTabById?.(this.manifest.id);
  };

  private foldPropertiesInActiveLeaf = async () => {
  // wait a tick so the view finishes mounting after openFile
  await new Promise((r) => setTimeout(r, 0));

  // TOGGLE unfold properties pane
  this.app.commands.executeCommandById("editor:toggle-fold-properties");
};

  // Temporary notification of public availability
  notifyPublicAvailability = () => {
    const shouldNotify = !hasNotifiedPublicAvailability();
    if (shouldNotify) {
      const link = document.createElement("a");
      link.appendText("Connect");
      link.onclick = () => this.openSettingsPage();

      const df = new DocumentFragment();
      df.appendText("🔥 Song Links is now publicly available. ");
      df.appendChild(link);
      df.appendText(" your Spotify to start linking!");
      new Notice(df, 0);
      setHasNotifiedPublicAvailability();
    }
  };

  // Ensure folder exists (creates nested folders)
  ensureFolderExists = async (folderPath: string) => {
    const folder = (folderPath ?? "").replace(/^\/+|\/+$/g, "").trim();
    if (!folder) return;

    // create nested folders step-by-step
    const parts = folder.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        await this.app.vault.createFolder(cur);
      }
    }
  };

  // Helper to sanitize filenames
  sanitizeFileName = (name: string) => {
    return name.replace(/[\\/:*?"<>|]/g, "").slice(0, 200).trim();
  };

  // Create or open a song note for the current playing song
  createSongNote = async () => {
    const token = await getToken();

    if (token === undefined) {
      new Notice("🎵 Connect Spotify in settings first");
      this.openSettingsPage();
      return;
    }

    const song = await fetchCurrentSong(token.access_token);

    if (song === undefined) {
      new Notice("❌ No song playing");
      return;
    }

    const folder = (this.settings.songsFolder ?? "").replace(/^\/+|\/+$/g, "").trim();
    await this.ensureFolderExists(folder);


    /*console.log("[SongLinks] song:", song);
    if (!song.id) { new Notice("❌ song.id missing (check fetchCurrentSong mapping)"); return; }
    let af;
    try {
      af = await fetchAudioFeatures(token.access_token, song.id);
      console.log("[SongLinks] af:", af);
    } catch (e) {
      console.error("[SongLinks] fetchAudioFeatures crashed:", e);
      new Notice("❌ audio-features fetch failed (check console)");
      af = undefined;
    }*/

    // Search for an existing note containing the song URL
    const files = folder
      ? this.app.vault.getFiles().filter((f) => f.path.startsWith(`${folder}/`))
      : this.app.vault.getFiles();
    for (const file of files) {
      if ((file.extension ?? "") !== "md") continue;
      try {
        const content = await this.app.vault.read(file);
        if (content.includes(song.link)) {

          const leaf = this.app.workspace.getLeaf(false);
          await leaf.openFile(file);
          await this.foldPropertiesInActiveLeaf();
          new Notice("✅ Opened existing song note");
          return;
        }
      } catch (e) {
        // ignore read errors for individual files
        console.error(e);
      }
    }

    // Build frontmatter and body
    const artistName = song.artists?.[0]?.name ?? "";
    const artistLink = song.artists?.[0]?.link ?? "";
    const albumName = song.album?.name ?? "";
    const releaseDate = song.album?.release_date ?? "";

    const frontmatter = [
      "---",
      `Song Name: "${song.name}"`,
      `Song link: "${song.link}"`,
      `Artist Name: "${artistName}"`,
      `Artist Link: "${artistLink}"`,
      `Album name: "${albumName}"`,
      `Release date: "${releaseDate}"`,
      /*`Danceability: ${af?.danceability ?? ""}`,
      `Energy: ${af?.energy ?? ""}`,
      `Loudness dB: ${af?.loudness ?? ""}`,
      `Speechiness: ${af?.speechiness ?? ""}`,
      `Acousticness: ${af?.acousticness ?? ""}`,
      `Instrumentalness: ${af?.instrumentalness ?? ""}`,
      `Liveness: ${af?.liveness ?? ""}`,
      `Valence: ${af?.valence ?? ""}`,
      `Tempo BPM: ${af?.tempo ?? ""}`,*/
      "---",
    ].join("\n");

    const body = [
      ``,
    ].join("\n\n");

    const baseName = this.sanitizeFileName(song.name || "Untitled Song");
    const prefix = folder ? `${folder}/` : "";
    let filePath = `${prefix}${baseName}.md`;

    let ix = 1;
    while (this.app.vault.getAbstractFileByPath(filePath)) {
      ix += 1;
      filePath = `${prefix}${baseName} - ${ix}.md`;
    }

    try {
      const file = await this.app.vault.create(filePath, `${frontmatter}\n\n${body}`);
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
      await this.foldPropertiesInActiveLeaf();
      new Notice("✅ Created song note");
    } catch (e) {
      console.error("Error creating song note:", e);
      new Notice("❌ Failed to create song note");
    }
  };

  /**
   * onload for the plugin. Simply load settings, add the plugins command, and register a SettingTab
   */
  async onload() {
    await this.loadSettings();

    // This adds an editor command that can perform some operation on the current editor instance
    this.addCommand({
      id: "insert-song-link",
      name: "Insert song link",
      editorCallback: this.insertSongLink,
    });

    // New command to create/open song note (users can assign hotkey via Obsidian)
    this.addCommand({
      id: "create-song-note",
      name: "Create/open song note",
      callback: this.createSongNote,
    });

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new SettingTab(this.app, this));

    // Temporary notification of public availability
    this.notifyPublicAvailability();
  }

  /**
   * onunload for the plugin. TODO: Anything?
   */
  onunload() {}

  /**
   * Default loadSettings from docs
   */
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  /**
   * Default saveSettings from docs
   */
  async saveSettings() {
    await this.saveData(this.settings);
  }
}
