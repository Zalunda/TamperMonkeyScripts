# TamperMonkeyScripts

| Item | Description |
|------|-------------|
| [jav-scene-triage.js](jav-scene-triage.js) | **JAV Scene Triage**, a Tampermonkey script: finds scene descriptions, remembers seen scenes across sites, opens all unseen scenes, keeps a wanted list. |
| [startup-pinned-tab/](startup-pinned-tab/) | Small Chrome extension: on browser start, switches to the first pinned tab and closes the blank New Tab page. |

## What the script does

**JAV Scene Triage** (`jav-scene-triage.js`) helps you go through the torrent listings on sukebei and
the scene listing sites, without looking at the same scene twice.

### Find the description of a scene (sukebei)

- On sukebei/nyaa, an **ℹ** link is added before every scene code (e.g. `MDVR-451`).
- Clicking it probes a list of sites in priority order (jvrlibrary, javdatabase, r18.dev,
  maxjav) and opens the first one that has the scene. If none has it, the link turns into
  **ℹ✗** (and a Google search of the code opens instead).
- The torrent/magnet links of the sukebei row are remembered, so they show up in a box
  at the top left of the scene's page: **⬇ Torrent**, **🧲 Magnet**, link back to the
  sukebei page, and **➕ qBittorrent** to send it straight to qBittorrent.

### Remember scenes already seen, across all sites

- Each scene has one shared "seen" state (`VRKM-01941` and `vrkm-1941` are the same scene),
  stored by Tampermonkey and used on every site listed above.
- A scene becomes seen when you make a decision on its page: **➕ qBittorrent**,
  **★ I want**, or **✖ Not interested**. Each of these also closes the tab.
- Seen scenes are shown as **ℹ✓** / "✓ seen" and greyed out. The **Hide seen** button in the
  toolbar hides them completely (setting is remembered per site).
- The ⚙ form can export/import the seen list as a text file (to back it up or share it
  between browsers) and set code prefixes to ignore.

### Open all unseen scenes from a page

- The toolbar on each listing page has **Open all unchecked**: it opens, in background
  tabs next to the current one, every scene on the page that isn't seen yet.
- **Open next 20** opens the next 20 unseen scenes: first the ones on this page, then it
  follows the next pages (`/page/2/` on the listing sites, `?p=2` on sukebei) until it has 20 (or runs out of pages).
  On sukebei only scenes that have a description page count toward the 20. The number is set in ⚙
  (**Scenes for "Open next"**, default 20, 0 hides the button).
  The script remembers, per listing (or per sukebei search), the last page it picked a scene from. Next time you click it
  from page 1, it restarts 1 page before that (`RESUME_BACK_PAGES`) instead of re-reading all the earlier pages. If you
  cleared your seen list, use the Tampermonkey menu command **Forget "Open next" remembered pages**.
- The toolbar is at the top left by default; choose top/bottom and left/right in ⚙ (**Toolbar position**).
- On sukebei it first looks each scene up (3 at a time) and opens the page found.
  On the listing sites (3xplanet, jav-angel, maxjav, myjavbay) it opens the scene pages directly.
- Tabs are opened alphabetically by code (can be changed to page order in ⚙). Then go
  through the tabs one by one, deciding on each; this is what feeds the seen list.

### Keep a list of wanted scenes

- On 3xplanet, jav-angel and maxjav scene pages, **★ I want** adds the page to the wanted list. It is only shown when the script found no torrent/magnet link for the scene (otherwise you have **➕ qBittorrent** or **⬇ Torrent** / **🧲 Magnet** instead).
- The **★ Wanted (n)** toolbar button shows the list (shared by every site). Each entry can be
  removed, and **Open all** opens them all in tabs.
- On listing pages, wanted scenes get an orange **★ wanted** badge instead of the grey "✓ seen" one, and they are never greyed out or hidden by **Hide seen**.
- **✖ Not interested** on a wanted scene removes it from the list.

### qBittorrent

Click ⚙ and enter the qBittorrent Web UI address, login and share-ratio limit.
On myjavbay, scene pages get **➕ qBittorrent** using the magnet link found on the page.

## Setup: a dedicated Chrome profile

It is safer to run these in a **separate Chrome profile** instead of your main one.
Tampermonkey (and any unpacked extension in developer mode) can read and modify
**every site** you visit. A separate profile acts as a different container:
its cookies, logins, history and other extensions are isolated from your main
browsing (email, banking, etc.), so a bad script or extension can't see them.

### 1. Create the profile

1. In Chrome, click your profile icon (top right, next to the menu `⋮`).
2. Click **Add Chrome profile** (or **Add** under "Other profiles").
3. Choose **Continue without an account** (keeps it fully separate; no sync).
4. Give it a name (e.g. `Scripts`) and a color, then click **Done**.
5. A new Chrome window opens using that profile. Use this window for everything below.

### 2. Turn on Developer mode

Both Tampermonkey (to run user scripts) and the startup-pinned-tab extension need
**Developer mode** enabled in this profile:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).

(This setting is per profile, which is another reason to use a dedicated one.)

### 3. Install Tampermonkey and the script

1. In the new profile, open the Chrome Web Store and install **Tampermonkey**.
2. Pin it to the toolbar (puzzle-piece icon, then the pin).
3. In `chrome://extensions`, click Tampermonkey **Details** and make sure
   **Allow User Scripts** is enabled (only available with Developer mode on in recent Chrome versions).
4. Install the script by opening its raw URL in Chrome:
   <https://github.com/Zalunda/TamperMonkeyScripts/raw/main/jav-scene-triage.js>
   Tampermonkey shows an install page; click **Install**.
   Alternatively: Tampermonkey menu, **Create a new script...**, paste the file content, **Ctrl+S**.

### 4. Open and pin the supported sites

Open each of these and pin the tab (right-click tab, **Pin**):

- <https://sukebei.nyaa.si/>
- <https://myjavbay.com/>
- <https://maxjav.com/category/vr/>
- <https://3xplanet.net/tag/vr/>
- <https://jav-angel.net/tag/vr/>

Suggestion: turn on vertical tabs (right-click the tab bar, **Show tabs vertically**,
or Chrome settings, Appearance) so the pinned tabs stay readable.

### 5. Install the startup-pinned-tab extension (optional)

This extension is unpacked (not on the Web Store):

1. Open `chrome://extensions` (Developer mode must be on, see step 2).
2. Click **Load unpacked** and select the [startup-pinned-tab](startup-pinned-tab/) folder.
3. Pin the tabs you want to start on (right-click tab, **Pin**). The first pinned tab
   is shown when Chrome starts.
4. In Chrome settings, under **On startup**, choose **Continue where you left off**
   so pinned tabs are restored.

Keep the folder in a stable location: Chrome loads the extension from it directly,
and it breaks if the folder is moved or deleted. After editing the files, click the
reload icon on the extension's card in `chrome://extensions`.

### Allow pop-ups on these sites

The **ℹ** link and **Open all unchecked** open new tabs, which Chrome may block as pop-ups
(a "Pop-up blocked" icon appears at the right of the address bar). Allow them once per site:

1. Click the blocked pop-up icon in the address bar.
2. Choose **Always allow pop-ups and redirects from ...** and click **Done**.
3. Reload the page.

Or add all the sites at once in `chrome://settings/content/popups`, under
**Allowed to send pop-ups and use redirects**, then **Add** each site
(`sukebei.nyaa.si`, `myjavbay.com`, `maxjav.com`, `3xplanet.net`, `jav-angel.net`).

Since pop-ups are now allowed on these sites, which are full of ads, it is a good idea to
also install a blocker in this profile (Chrome Web Store), such as **uBlock Origin Lite**
or **Ghostery**. They block the ad pop-ups and trackers, while the script's own
tabs (ℹ and Open all) still open.

### 6. Configure the script

Click the gear to configure qBittorrent if you use it.

### Tips

- Only install the extensions you need in this profile, and only scripts you trust.
- Use the main profile for anything sensitive; don't sign in to it from the scripts profile.
