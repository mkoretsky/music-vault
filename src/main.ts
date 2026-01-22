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
  fetchSongById,
  fetchArtistGenres,
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
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 25));

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const props = view?.containerEl.querySelector(".metadata-container");
    if (!props) continue;

    const isCollapsed =
      props.classList.contains("is-collapsed") ||
      props.getAttribute("aria-expanded") === "false";

    if (!isCollapsed) {
      this.app.commands.executeCommandById("editor:toggle-fold-properties");
    }
    return;
  }
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

  private buildSongFrontmatter = (song: Song) => {
  const artistsAll = (song.artists ?? []).map(a => a.name).filter(Boolean) as string[];
  const artistLinksAll = (song.artists ?? [])
    .map(a => a.link)
    .filter((x): x is string => !!x);
  const artistIdsAll = (song.artists ?? []).map(a => a.id).filter(Boolean) as string[];

  const albumName = song.album?.name ?? "";
  const releaseDate = song.album?.release_date ?? "";
  const genres = song.genres ?? [];

  return [
    "---",
    `Song Name: "${this.yamlDq(song.name)}"`,
    `Song link: "${this.yamlDq(song.link)}"`,
    `track_id: "${song.id}"`,
    `isrc: "${song.isrc ?? ""}"`,
    `duration_ms: ${song.duration_ms ?? '""'}`,
    `explicit: ${song.explicit ?? '""'}`,
    `popularity: ${song.popularity ?? '""'}`,
    `artists_all: [${artistsAll.map(n => JSON.stringify(n)).join(", ")}]`,
    `artist_ids_all: [${artistIdsAll.map(id => JSON.stringify(id)).join(", ")}]`,
    `artist_links_all: [${artistLinksAll.map(u => JSON.stringify(u)).join(", ")}]`,
    `genres: [${genres.map(g => JSON.stringify(g)).join(", ")}]`,
    `Album name: "${this.yamlDq(albumName)}"`,
    `Release date: "${releaseDate}"`,
    "---",
  ].join("\n");
};

private upsertFrontmatter = (content: string, newFrontmatter: string) => {
  // only replace the frontmatter block; keep everything else identical
  const m = content.match(/^(\s*---\s*\r?\n[\s\S]*?\r?\n---)(\r?\n?)([\s\S]*)$/);
  if (!m) return content; // dont touch if no frontmatter
  const [, , sep, rest] = m;
  return `${newFrontmatter}${sep}${rest}`;
};

private yamlDq = (s: unknown) => {
  const v = String(s ?? "");
  // Escape backslash first, then double quotes, then normalize newlines/tabs
  return v
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\n")
    .replace(/\t/g, "\\t");
};

private enrichSongWithGenres = async (song: Song, token: string): Promise<Song> => {
  const artistIds = (song.artists ?? []).map(a => a.id).filter(Boolean);
  if (!artistIds.length) return song;

  const genreMap = await fetchArtistGenres(token, artistIds);

  // Collect all genres from all artists, deduplicated
  const allGenres: string[] = [];
  for (const artistId of artistIds) {
    const genres = genreMap.get(artistId) ?? [];
    for (const g of genres) {
      if (!allGenres.includes(g)) allGenres.push(g);
    }
  }

  return { ...song, genres: allGenres };
};

// Extract track ID from Spotify URL (e.g., https://open.spotify.com/track/abc123?si=...)
private extractTrackId = (url: string): string | undefined => {
  const match = url.match(/spotify\.com\/track\/([a-zA-Z0-9]+)/);
  return match?.[1];
};

// Shared helper: find existing song note or create new one, then open it
private findOrCreateAndOpenSongNote = async (song: Song, splitRight: boolean) => {
  const folder = (this.settings.songsFolder ?? "").replace(/^\/+|\/+$/g, "").trim();
  await this.ensureFolderExists(folder);

  // Search for existing note by track_id
  const files = folder
    ? this.app.vault.getFiles().filter((f) => f.path.startsWith(`${folder}/`))
    : this.app.vault.getFiles();

  for (const file of files) {
    if ((file.extension ?? "") !== "md") continue;
    try {
      const content = await this.app.vault.read(file);
      if (new RegExp(`^\\s*track_id\\s*:\\s*["']?${song.id}["']?\\s*$`, "m").test(content)) {
        const newFm = this.buildSongFrontmatter(song);
        const updated = this.upsertFrontmatter(content, newFm);
        if (updated !== content) await this.app.vault.modify(file, updated);

        const leaf = splitRight
          ? this.app.workspace.getLeaf("split", "vertical")
          : this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
        await this.foldPropertiesInActiveLeaf();
        new Notice("✅ Opened existing song note (updated)");
        return;
      }
    } catch (e) {
      console.error(e);
    }
  }

  // No existing note found - create new one
  const frontmatter = this.buildSongFrontmatter(song);
  const body = ``;
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
    const leaf = splitRight
      ? this.app.workspace.getLeaf("split", "vertical")
      : this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    await this.foldPropertiesInActiveLeaf();
    new Notice("✅ Created song note");
  } catch (e) {
    console.error("Error creating song note:", e);
    new Notice("❌ Failed to create song note");
  }
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

    const enrichedSong = await this.enrichSongWithGenres(song, token.access_token);
    await this.findOrCreateAndOpenSongNote(enrichedSong, false);
  };

  // Open song note from the "Song link" property of the active note
  openSongNoteFromLink = async () => {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("❌ No active note");
      return;
    }

    // Read frontmatter to get Song link
    const content = await this.app.vault.read(activeFile);
    const linkMatch = content.match(/^["']?Song link["']?:\s*["']([^"']+)["']\s*$/m);
    if (!linkMatch) {
      new Notice("❌ No 'Song link' property found");
      return;
    }

    const songLink = linkMatch[1].trim();
    const trackId = this.extractTrackId(songLink);
    if (!trackId) {
      new Notice("❌ Invalid Spotify track URL");
      return;
    }

    const token = await getToken();
    if (token === undefined) {
      new Notice("🎵 Connect Spotify in settings first");
      this.openSettingsPage();
      return;
    }

    const song = await fetchSongById(token.access_token, trackId);
    if (song === undefined) {
      new Notice("❌ Could not fetch song from Spotify");
      return;
    }

    const enrichedSong = await this.enrichSongWithGenres(song, token.access_token);
    await this.findOrCreateAndOpenSongNote(enrichedSong, true);
  };

  // Refresh all song notes in the songs folder
  refreshAllSongNotes = async () => {
    const token = await getToken();
    if (token === undefined) {
      new Notice("🎵 Connect Spotify in settings first");
      this.openSettingsPage();
      return;
    }

    const folder = (this.settings.songsFolder ?? "").replace(/^\/+|\/+$/g, "").trim();
    const files = folder
      ? this.app.vault.getFiles().filter((f) => f.path.startsWith(`${folder}/`))
      : this.app.vault.getFiles();

    // Collect files with track_id
    const songFiles: { file: typeof files[0]; trackId: string; content: string }[] = [];
    for (const file of files) {
      if ((file.extension ?? "") !== "md") continue;
      try {
        const content = await this.app.vault.read(file);
        const match = content.match(/^\s*track_id\s*:\s*["']?([a-zA-Z0-9]+)["']?\s*$/m);
        if (match) {
          songFiles.push({ file, trackId: match[1], content });
        }
      } catch (e) {
        console.error(e);
      }
    }

    if (songFiles.length === 0) {
      new Notice("No song notes found to refresh");
      return;
    }

    new Notice(`Refreshing ${songFiles.length} song notes...`);

    let updated = 0;
    let failed = 0;

    for (let i = 0; i < songFiles.length; i++) {
      const { file, trackId, content } = songFiles[i];
      try {
        const song = await fetchSongById(token.access_token, trackId);
        if (!song) {
          failed++;
          continue;
        }

        const enrichedSong = await this.enrichSongWithGenres(song, token.access_token);
        const newFm = this.buildSongFrontmatter(enrichedSong);
        const updatedContent = this.upsertFrontmatter(content, newFm);

        if (updatedContent !== content) {
          await this.app.vault.modify(file, updatedContent);
          updated++;
        }
      } catch (e) {
        console.error(`Failed to refresh ${file.path}:`, e);
        failed++;
      }

      // Progress notice every 10 files
      if ((i + 1) % 10 === 0) {
        new Notice(`Progress: ${i + 1}/${songFiles.length} notes processed`);
      }
    }

    new Notice(`✅ Refresh complete: ${updated} updated, ${failed} failed`);
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

    // New command to open song note from the active note's Song link property
    this.addCommand({
      id: "open-song-note-from-link",
      name: "Open song note from link",
      callback: this.openSongNoteFromLink,
    });

    // Command to refresh all song notes with latest data from Spotify
    this.addCommand({
      id: "refresh-all-song-notes",
      name: "Refresh all song notes",
      callback: this.refreshAllSongNotes,
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
