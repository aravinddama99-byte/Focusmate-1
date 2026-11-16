# FocusMate Android app: setup

Open the `app2` folder in Android Studio (File → Open), let Gradle sync, then Build → Build APK(s). (Or push to GitHub: the workflow builds `FocusMate-apk`.)

Sign-in is **Google only**, checked by your own server, and everything you do in the app (tasks, sessions, XP, settings, chat, attendance, friends) is saved to a PostgreSQL database under your Google account. Sign in on a new phone and it all comes back.
Three one-time setups, about 15 minutes in total:

## 1. Google sign-in (Google Cloud Console)
1. Project → APIs & Services → **OAuth consent screen**. If its status is *Testing*, add every person who should sign in under **Test users**, or press **Publish app** so any Google account can sign in.
2. Credentials → **OAuth client ID → Web application**. Copy the Client ID. It goes in `AppConfig.GOOGLE_WEB_CLIENT_ID` (already filled in) and in the server's `GOOGLE_CLIENT_ID`.
3. Credentials → **OAuth client ID → Android**: package name `com.focusmate.lms`, SHA-1 fingerprint:

       9C:10:2C:06:3D:D0:56:2E:1E:AC:6D:40:93:D0:55:F0:E8:AA:56:B1

   That is the key in `app/debug.keystore`, which every build now uses (including GitHub Actions), so the fingerprint never changes. Without this Android client, the Google account picker fails with "No Google account available".
   For a Play Store release, sign with your own private key and add that key's SHA-1 as a second Android client.

## 2. Database (free Postgres)
Any Postgres works. Easiest: **neon.tech** (free, does not expire). Create a project and copy the **connection string** (`postgresql://user:pass@host/db?sslmode=require`). Tables are created automatically on first start.

## 3. Server (Render, Railway, Fly, your own PC; Node 18+)
Deploy the `server/` folder. Build command `npm install`, start command `node server.js`. Environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Postgres connection string from step 2 (**required**) |
| `GOOGLE_CLIENT_ID` | your Web client ID from step 1 (**required**; the server refuses to start without it) |
| `ALLOWED_DOMAINS` | optional, e.g. `cuchd.in,cumail.in` to limit sign-in to CU students |
| `ALLOWED_EMAILS` | optional, extra individual emails allowed in |

Put the server's HTTPS address in `AppConfig.BACKEND_URL` and rebuild. Check `https://your-server/` shows `{"ok":true,"db":true}`.
You can delete the old `DATA_FILE` variable: it is no longer used.

### How it works
* The phone gets a Google ID token, sends it to `/auth`, and the server verifies Google's signature, audience and expiry itself. Only then does it create or find your account (keyed by Google's permanent user id) and hand back a 90-day session.
* On launch the app loads your saved data before showing the UI. While you use it, changes are saved about every 10 seconds, and when you leave the app or sign out.
* If another phone saved newer data than this one has seen, the app asks which to keep instead of silently overwriting.
* Signing in with a different Google account on the same phone never mixes data.

## Blocking apps
Open Focus → turn on Distraction Shield → pick apps. The first time, the app sends you to Accessibility settings: enable "FocusMate App Blocker".
Opening a blocked app during a session shows: "You opened X. You'll lose 25 XP" with **Stay focused**, **End focus session**, **Open anyway (−25 XP)**.

## CU LMS
Two ways: (a) enter your CU login if you run your own sync server (address under "Sync server address"), or (b) **Backup: log in inside the app**: LMS opens inside FocusMate, log in, open your subjects/assignments page and tap **Import to FocusMate**.
