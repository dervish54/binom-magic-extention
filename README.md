# Binom Magic

Russian version: [README.ru.md](C:/Users/Mikhail/binom-magic-extention/README.ru.md)

Chrome MV3 extension for Binom report pages. It shows source-side metrics in a hover overlay without changing the report table.

## What It Does

- Hold `Ctrl` over a supported row to open the overlay
- Double-tap `Ctrl` to pin or unpin it
- Prefetch visible rows from the context menu
- Copy debug IDs with `Alt+Shift+C`
- From the pinned overlay, stop or start campaigns and teasers
- From the pinned overlay, overwrite spend in Binom using current source-side spend

## Use Case

The extension is built for a Binom + AdsKeeper workflow:

- read report context from a Binom page
- resolve the related source-side entity
- request metrics in the background
- show them directly on hover
- allow quick operational actions on campaigns and teasers from the pinned overlay

## Project Layout

- `extension/` - unpacked Chrome extension
- `docs/` - specs and product notes

## Local Setup

1. Open `chrome://extensions/`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `extension/`
5. Open extension options
6. Fill in your own settings:
   - Binom tracker URL, for example `https://your-binom-tracker.example.com`
   - Binom tracker API key
   - source-side credentials such as `idAuth`, API token, and optional API base URL

## Notes

- The extension is intended for private/internal usage.
- It uses direct API credentials, so treat tracker and source tokens as sensitive.
- For shared or production usage, a backend/proxy layer is safer than storing powerful tokens in the browser.
