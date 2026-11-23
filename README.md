# ScreenGuide

ScreenGuide is an AI screen coach. It observes one user-selected screen or window, listens while a session is active, and provides one step at a time through voice and optional highlights. It never clicks or types.

This repository contains two OpenAI-powered editions:

- **Windows desktop:** OpenAI Realtime coaching with a user-provided API key held only in app memory.
- **Web:** faster cloud coaching through OpenAI Realtime over WebRTC. The browser never receives the OpenAI API key.

## Web edition

The web edition captures only the screen or application the user explicitly chooses. It sends visually changed frames rather than continuous video, includes a high-resolution overview plus a native-detail crop for small menus, and uses two interaction states: **Ready** means the microphone is accepting speech; **Wait** means input is temporarily muted while the coach evaluates or speaks.

Browser security prevents a web page from drawing over another Windows application, so web highlights appear on the live preview inside ScreenGuide. Use the Windows desktop edition when an always-on-top overlay is required.

### Run the web edition locally

Requirements: Node.js 24 or newer and an OpenAI project API key with access to `gpt-realtime-2.1`.

1. Copy `.env.example` to `.env`.
2. Put the API key in `OPENAI_API_KEY`. It is read only by the local session service.
3. Run:

```powershell
npm install
npm run web:dev
```

Open `http://127.0.0.1:5174`. Chrome or Edge is recommended. Share an application window when possible; if you share the whole display, keep ScreenGuide away from the application to avoid a recursive preview.

### Host the frontend on GitHub Pages

GitHub Pages hosts static files only, so the included `api/session.mjs` must run separately on a Node-compatible serverless host. It exchanges the browser's WebRTC offer with OpenAI and never returns the API key.

Configure the session service with:

- `OPENAI_API_KEY`: the server-side OpenAI project key.
- `SCREENGUIDE_ACCESS_TOKEN`: a long private access code recommended for any public deployment.
- `ALLOWED_ORIGINS`: the Pages origin, such as `https://YOUR_NAME.github.io`.

Then add a GitHub repository variable named `SCREENGUIDE_SESSION_ENDPOINT` containing the public HTTPS URL of that endpoint, such as `https://YOUR_SERVICE.example/api/session`. In **Settings → Pages**, choose **GitHub Actions** as the publishing source. The included `deploy-web.yml` workflow checks and deploys the site on pushes to `main`.

Do not put `OPENAI_API_KEY` in GitHub Pages variables, Vite variables, frontend source, or repository secrets used during the static build. The key belongs only on the session service.

## Windows desktop edition

The desktop edition uses `gpt-realtime-2.1` for screen understanding, live voice, and typed questions. Enter an OpenAI project API key during onboarding. The key stays in the Electron main process and memory only; it is never written to settings, logs, transcripts, or the packaged app.

Reaching the user's goal does not automatically close coaching. ScreenGuide reports that the goal appears complete and asks whether the user wants to end. A session ends only when the user explicitly asks by voice or text, clicks **End session**, presses the emergency-stop shortcut, or closes the app.

### Run the desktop edition locally

Requirements: Windows 11, Node.js 20 or newer, and an OpenAI project API key with access to `gpt-realtime-2.1`.

```powershell
npm install
npm run dev
```

### Desktop shortcuts

- `Ctrl+Shift+Space`: pause or resume screen capture and microphone processing
- `Ctrl+Shift+Esc`: immediately end the session

## Verify and package

```powershell
npm test
npm run build
npm run web:build
npm run dist
```

The unsigned Windows installer is emitted to `release/`. The local build disables executable editing/signing so it can package without downloading Electron Builder's signing helper. For a certificate-backed distribution build, set `win.signAndEditExecutable` to `true` and provide the standard Electron Builder signing environment variables.

Diagnostic screenshot saving is off by default. When enabled for testing, ScreenGuide writes exactly the overview and changed-region crop sent to OpenAI under `Documents\ScreenGuide Diagnostics`.
