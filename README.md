# TamperMonkeyScripts

| Item | Description |
|------|-------------|
| [scene-info-link.user.js](scene-info-link.user.js) | Tampermonkey script: adds an "info" link before scene codes on nyaa/sukebei and opens the first site that has the scene. |
| [startup-pinned-tab/](startup-pinned-tab/) | Small Chrome extension: on browser start, switches to the first pinned tab and closes the blank New Tab page. |

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
4. Install the script: open the raw `scene-info-link.user.js` file (or drag the file
   into Chrome). Tampermonkey shows an install page; click **Install**.
   Alternatively: Tampermonkey dashboard, **+** tab, paste the file content, **Ctrl+S**.

### 4. Install the startup-pinned-tab extension

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

### Tips

- Only install the extensions you need in this profile, and only scripts you trust.
- Use the main profile for anything sensitive; don't sign in to it from the scripts profile.
