# FlyffU Launcher - Privacy Policy
**Effective date:** September 23, 2025

This Privacy Policy explains what information FlyffU Launcher (“the App”, “we”, “us”) processes, how it’s used, and what choices you have. The App is an Electron-based desktop launcher that helps you manage and open Flyff Universe sessions.

## Summary (TL;DR)
- We **don’t collect analytics** or sell personal data.
- Your data is stored **locally on your device** and never uploaded by the App.
- The App makes **direct network requests** only to check for updates (GitHub) and to fetch the Flyff Universe news page (universe.flyff.com).
- You can **export, import, clear, or delete** your local data from within the App.

## Information We Process

### 1) Data stored locally by the App
- **Profiles list:** profile names, selected “job” class, window frame preference, and window size/position (if saved). Stored in your OS app-data directory as `profiles.json`.
- **Per-profile browser data:** site cookies, cache, localStorage for Flyff Universe, kept in a dedicated Electron “partition” per profile. You can clear these per profile or delete the profile to remove them.
- **Screenshots you take:** saved as PNG files in your system Pictures folder under **“FlyffU Launcher Screenshots”**.
- **Pending delete queue / Trash:** when removing profile data, folders may be moved to a local Trash area before being fully removed.

### 2) Minimal app/usage info
- **App version** (to show a version label / check updates) and simple UI state (e.g., whether any sessions are active, mute toggles, menu visibility). All handled locally.

### 3) Network requests the App makes
- **Update check:** queries GitHub Releases for the latest version (sends a standard HTTP request with a simple `User-Agent`).
- **News feed fetch:** downloads the HTML from `https://universe.flyff.com/news` to display recent updates/events/item-shop news.
- **Gameplay:** the game is opened at `https://universe.flyff.com/play` inside an Electron BrowserWindow tied to your chosen profile partition. External links you click may open in your default browser.

> We do **not** send your profiles, screenshots, or other local files to any server. Any data sent to GitHub or Flyff Universe occurs when the App downloads release metadata or website content respectively, just like a normal web browser request.

## How We Use Information
- **To operate the App:** manage profiles, launch sessions, remember window state, and show a news panel.
- **To provide optional features you trigger:** taking and saving screenshots, muting/unmuting a session, importing/exporting profiles.
- **To keep the App current:** checking if a newer release is available on GitHub.

## Data Sharing & Transfers
- We do **not** share or sell personal data.  
- Network requests to third parties are limited to:
  - **GitHub** (update checks)  
  - **Flyff Universe** (news page and game site)  
  These services receive typical request metadata (e.g., IP address) required to deliver content, the same as visiting those sites in a browser.

## Cookies & Site Storage
- Cookies and site storage belong to the **Flyff Universe** site and live **inside each profile’s partition**.  
- You can clear a profile’s cookies/cache or delete the profile to remove them.

## Your Controls
Inside the App you can:  
- **Create, rename, clone, or delete** profiles (deleting removes their saved browser data).  
- **Clear profile data** (cookies/cache/localStorage).  
- **Reset saved window size/position**.  
- **Import/Export** `profiles.json`.  
- **Open screenshots folder** and manage or delete your screenshots.

## Data Retention
- **Profiles & partitions:** kept locally until you clear or delete them.  
- **Screenshots:** kept locally until you delete them.  
- **Trash/pending delete items:** removed as soon as the system allows.

## Security
- Data is stored locally using OS user-data paths; partitions isolate site data per profile.  
- Deletions use safe operations (including retries and a local Trash step) to avoid partial removals. We recommend securing your device account and filesystem with appropriate OS protections.

## Children’s Privacy
The App is a utility for managing a game launcher and is **not directed to children**. If you are a parent/guardian and believe a child provided personal information through the App, please remove the local data from your device (delete profiles, partitions, and screenshots).

## International Users
Because the App stores data locally and does not operate a backend service, international transfers by us do not occur. Accessing GitHub or Flyff Universe involves standard web requests to those services in their respective regions.

## Changes to This Policy
We may update this Policy as the App evolves. Material changes will be reflected by updating the “Effective date” above and the App’s repository release notes.

## Contact
Questions or concerns? Please reach out via the project’s GitHub repository issues page: **toffeegg/FlyffU-Launcher**.
