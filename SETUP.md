# FocusMate Android app: setup

Open the `app2` folder in Android Studio (File → Open), let Gradle sync, then Build → Build APK(s).
Without any extra setup the app already works: splash intro, device Google-account sign-in, focus sessions, app blocker, in-app LMS login + import.
Two things need your own accounts if you want them:

## 1. Real Google sign-in (optional)
Without this the app uses the phone's built-in Google account chooser (works, but the account is not verified by Google).
1. Google Cloud Console → create a project → APIs & Services → OAuth consent screen.
2. Credentials → Create OAuth client ID → **Web application**. Copy its Client ID.
3. Credentials → Create OAuth client ID → **Android**, package `com.focusmate.lms`, SHA-1 from `./gradlew signingReport` (debug key).
4. Paste the Web client ID into `AppConfig.GOOGLE_WEB_CLIENT_ID`.

## 2. Friends, 8-digit codes and shared XP (optional)
1. Deploy the `server/` folder anywhere that runs Node 18+ (Render, Railway, Fly, your own PC). Start command: `node server.js`.
   Optional env: `GOOGLE_CLIENT_ID` (same Web client ID; then Google tokens are verified), `DATA_FILE` (use a persistent disk path).
2. Put the HTTPS address in `AppConfig.BACKEND_URL`, e.g. `https://focusmate-api.onrender.com`.
3. Rebuild. Friends → your unique 8-digit code appears. A friend types it in and you are connected; XP, level, streak and focus time are shared (respecting each person's Settings → Privacy).

## Blocking apps
Open Focus → turn on Distraction Shield → pick apps. The first time, the app sends you to Accessibility settings: enable "FocusMate App Blocker".
Opening a blocked app during a session shows: "You opened X. You'll lose 25 XP" with **Stay focused**, **End focus session**, **Open anyway (−25 XP)**.

## CU LMS
Two ways: (a) enter your CU login if you run your own sync server (address under "Sync server address"), or (b) **Backup: log in inside the app**: LMS opens inside FocusMate, log in, open your subjects/assignments page and tap **Import to FocusMate**.
