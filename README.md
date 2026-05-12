# BSKY_Backlog V2
A feed viewer for Bluesky that aggregates posts from all accounts you follow into a single feed with filtering and sorting capabilities.
Current version hosted at: https://phoenixium.de/bsky_backlog

## Features
- **Authentication** - Log in with your Bluesky app password (never stored); supports up to two accounts simultaneously (A/B)
- **Multi-account support** - Like and repost as either of two logged-in accounts independently
- **Feed Modes**
  - **Following Feed** - Aggregates posts from everyone you follow
  - **Author Feed** - Browse all posts from a specific account within a date range
  - **Author Likes** - Browse an account's liked posts (lazy-loaded on scroll)
- **Multiple handle inputs** - Aggregate follows from more than one account using the `+` button
- **Filtering**
  - Filter by date range (start and end dates)
  - Filter by post type (posts only, posts with replies, posts with media, etc.)
  - Sort by oldest/newest
- **Deduplicate posts** - Optionally collapse duplicate posts across followed accounts
- **Mute/Block filter** - Automatically hides posts from accounts you've muted or blocked (toggleable)
- **Like and repost posts** directly from the viewer (when authenticated)
- **Dark Mode** - with saved preferences
- **Progress bar** - Scroll-position indicator at the top of the page
- **Image Gallery**
  - View full-size images with multi-image navigation
  - Keyboard shortcuts: Left/Right arrows to navigate, Escape to close
- **Image preloading** - Full-size images preload on hover (can be disabled)
- **Video Support** - Watch videos embedded in posts
- **Quote Reposts & Replies** - See parent posts and context for replies
- **External Links** - Display GIFs and media files as interactive content, with theme-aware styling
- **Right Sidebar** (toggleable)
  - **Search Posts** - Live search across loaded posts with "Back to Reading" position restore
  - **Conversation Thread** - Inline thread viewer for any post
  - **Suggested Accounts** - Ranks accounts appearing in your feed by post frequency
- **Caching** - IndexedDB-based caching
- **Rate Limiting** - Built-in rate limiting to respect API limits

### Frontend
- **Vanilla JavaScript (`app.js`), HTML5 & CSS3** - No framework dependencies; no backend required

## Deployment

The app is fully client-side. No server-side backend is needed.

**Static hosting (any provider)**
Upload `index.html`, `style.css`, and `app.js` to any static host or subdirectory:

```
https://example.org/bsky_backlog/
```

**Local development**
```
python -m http.server 8000
```
Then open `http://localhost:8000`.

Authentication and token refresh call the Bluesky API directly from the browser (`https://bsky.social/xrpc`). No PHP, Python, or server-side proxy is required.

## Configuration

### Feed Mode
Select from the **Mode** dropdown before loading:
- **Following Feed** - Loads posts from all accounts followed by the entered handle(s)
- **Author Feed** - Loads posts by the entered handle within the selected date range
- **Author Likes** - Loads liked posts for the entered handle (lazy-fetched on scroll)

### Multiple Handles
Click `+` to add additional handle inputs. In Following Feed mode, follows from all entered accounts are merged and deduplicated.

### Date Inputs
- Defaults to today's date at 00:00 (local timezone)
- Adjust to filter posts from specific time periods

### Filter Options
- **Posts & Replies** - All posts including replies
- **Posts Only** - Original posts, no replies
- **Posts with Media** - Posts containing images or videos
- **Posts & Threads** - Posts and threaded conversations
- **Posts with Video** - Posts containing video content

Currently filters via `app.bsky.feed.getAuthorFeed` filter values. More filters planned; feedback welcome.

### ⋯ Menu Options
- **Image Preload** - Toggle hover-preloading of full-size images
- **Mute/Block: ON/OFF** - Toggle filtering of muted/blocked accounts
- **Grouped by Type** - Toggle account-grouped interaction layout
- **Deduplicate Posts** - Toggle deduplication of posts appearing multiple times
- **Clear Cache** - Clears IndexedDB cache with progress indicator
- **Debug: Load Post** - Load a single post by URL or AT URI

### APIs
- Bluesky Public API - `https://public.api.bsky.app/xrpc`
- Bluesky Authenticated API - `https://bsky.social/xrpc`

## Session Management

- **Token TTL** - 2 hours (automatically refreshed every 90 minutes)
- **Cache Duration** - 24 hours (auto-refreshed on login)
- **Session Storage** - IndexedDB (browser-side only)
- **Multi-account** - Up to two accounts (slots A and B) with independent interaction state

## Privacy & Security

- **No password storage** - Only app passwords are used, never stored
- **No tracking** - No analytics or telemetry
- **No cookies** - Uses IndexedDB for session storage
- **No server storage** - All data and API requests are client-side; no backend proxy

## Troubleshooting

### External Links & Media
- Automatically detects and displays animated media (GIFs, WebP, MP4, WebM)
- Non-media external links show as styled preview cards with thumbnail, title, and domain

## Supported Content Types

### Embed Types
- **Direct Images** (`app.bsky.embed.images`) - Standard image posts
- **Record with Media** (`app.bsky.embed.recordWithMedia`) - Posts with images and quoted content
- **Videos** (`app.bsky.embed.video`) - Video embeds with playback controls
- **Quote Posts** (`app.bsky.embed.quote`) - Quoted posts with parent context
- **External Links** (`app.bsky.embed.external#view`) - Links with preview cards or animated media
- **Record View** (`app.bsky.embed.record#view`) - Thread context and replies

### Media Support
- **Image Formats**: JPEG, PNG, WebP, GIF
- **Video Formats**: MP4, WebM
- **Animated Media**: Full animation support for GIFs and WebP animations
- **External URLs**: Auto-detection of media files with fallback to preview cards

### Caching
- Automatically caches posts (15-minute TTL)
- Caches followed accounts (4-hour TTL)
- Caches resolved handles (4-hour TTL)
- Manual cache clearing available via ⋯ menu

## Rate Limiting

### API Rate Limits (Bluesky)
- 3000 requests per 5 minutes per IP (authenticated, `bsky.social`)

The app respects these limits automatically through:
- `bskyFetch()` wrapper reads `RateLimit-*` response headers and pauses proactively when quota is low
- Automatic retry with backoff on HTTP 429
- Batched requests (20 accounts at a time)
- 300ms delays between batches
- 100ms delays between paginated requests

## PDS Auto-Discovery

For Author Feed and Author Likes modes, the app resolves each user's home Personal Data Server (PDS) via their DID document (`plc.directory` or `.well-known/did.json`). This allows fetching data directly from the user's PDS rather than routing through the AppView, with automatic fallback to `bsky.social`.

## Disclaimer

This tool is not affiliated with Bluesky or Bluesky Social. Use at your own risk and comply with Bluesky's Terms of Service and API usage policies.