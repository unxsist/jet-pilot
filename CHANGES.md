# Changelog

## 0.3.0 (2022-09-29)

- Feat: added debug config for VSCode. Thanks @gabriel-andreescu for the contribution!
- Feat: added vue-devtools integration.
- Feat: open browser devtools automatically on start.
- Feat: changed app icon to Vue icon.
- Feat: added `RUST_BACKTRACE=1` to the default dev command.
- Fix: added empty dist folder to make Rust extension happy.
- Fix: fixed Vite build target to match tauri create app config.
- UI: smarter styles and markup.
- Docs: documented howto implement Electron-like `titleBarStyle: 'hidden'` window, and that the sync backend commands block the UI.
- Chore: bumped deps.

## 0.2.0 (2022-07-10)

- Fix: changed app name (`packageName` in `src-tauri/tauri.conf.json`).
- Fix: made Vite config more robust.
- Tooling: added `.vscode` and recommendation fot Volar extension.
- Refactor: removed `vite-plugin-tauri` from frontend deps.
- Chore: tweaked Vite config for better dev experience.
- Chore: bumped deps.
- Docs: better README.

## 0.1.0 (2022-06-16)

Hello Tauri 1.0!

- Feat: Added a separate release workflow.
- Refactor: converted menu to use `Menu::os_default`. Thank You to @JonasKruckenberg for the tip!
- Docs: added more docs on usage, fixed prerequisites link.
- Chore: Bumped all Vite + Tauri deps.

## 0.0.1 (2022-04-27)

- Initial version
