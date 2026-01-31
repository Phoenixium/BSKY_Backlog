# BSKY_Backlog
A feed viewer for Bluesky that aggregates posts from all accounts you follow into a single feed with filtering and sorting capabilities.
Current version hosted at: https://phoenixium.de/bsky_backlog

## Features
-  **Authentication** - Log in with your Bluesky app password (never stored)
-  **Filtering**
  - Filter by date range (start and end dates)
  - Filter by post type (posts only, posts with replies, posts with media, etc.)
  - Sort by oldest/newest
-  **Like and repost posts** directly from the viewer (when authenticated)
-  **Dark Mode** - with saved preferences
-  **Image Gallery** 
  - View full-size images with multi-image navigation
  - Keyboard shortcuts: Left/Right arrows to navigate, Escape to close
-  **Image preloading** - Fullsize images preload on hover (can be disabled)
-  **Video Support** - Watch videos embedded in posts
-  **Quote Reposts & Replies** - See parent posts and context for replies
-  **External Links** - Display GIFs and media files as interactive content, with theme-aware styling
-  **Caching** - IndexedDB-based caching
-  **Rate Limiting** - Built-in rate limiting to respect API limits

### Frontend
- **Vanilla JavaScript, HTML5 & CSS3** - No framework dependencies

## Deployment

#### Option 1: Local Development
**Start the Python backend** (recommended for development)
   python backend.py (runs on :3000)
   
   start a static file server
   python -m http.server 8000
   Then open your browser at `http://localhost:8000`

#### Option 2: Hosting
Requirements:
- PHP 7.4 or higher
- cURL extension enabled
- memcached extension active (optional), has file-based fallback

**Upload files to your hosting**
   - `index.html` ,`style.css` and `backend.php` into a subdirectory /bsky_backlog/ to your hosting/website. 

   https://example.org/bsky_backlog/
   
The `backend.php` handles authentication and token refresh securely:

**Endpoints:**
- Both login and refresh requests go to: `/bsky_backlog/backend.php`
- The backend auto-detects the action from request body:
  - `{identifier, password}` → Login
  - `{refreshJwt}` → Token refresh
  
**Backend Features:**
-  **Secure Authentication** - Forwards to Bluesky API, never stores passwords
-  **Token Refresh** - Auto-renews tokens before expiry
-  **Rate Limiting** - 5 login attempts per 15 minutes per IP
  - Uses **Memcached** if available (recommended)
  - Falls back to **file-based** storage if Memcached unavailable
  - No external extensions required
-  **No Information Disclosure** - Generic error messages
-  **CORS Support** - Works with any origin

### Debug Features

Available via "..." menu:
- **Load Post** - Debug tool to load a single post by URL or ID
- **Load Author Feed** - Debug tool to load posts from a specific author
- **Clear Cache** - Manual cache clearing with progress indicator and smart timeout handling

## Configuration

### Date Inputs
- Defaults to today's date at 00:00 (local timezone)
- Adjust to filter posts from specific time periods
- Leave empty to see all posts

### Filter Options
- **Posts & Replies** - All posts including replies
- **Posts Only** - Original posts, no replies
- **Posts with Media** - Posts containing images or videos
- **Posts & Threads** - Posts and threaded conversations
- **Posts with Video** - Posts containing video content
currently only filters via the "app.bsky.feed.getAuthorFeed" filter values.
more filters planned, feedback and ideas welcome

### APIs
- Bluesky Public API - `https://public.api.bsky.app/xrpc`
- Bluesky Authenticated API - `https://bsky.social/xrpc`


## Session Management

- **Token TTL** - 2 hours (automatically refreshed every 90 minutes)
- **Refresh Token TTL** - 90 minutes auto-renewal
- **Cache Duration** - 24 hours (auto-refreshed on login)
- **Session Storage** - IndexedDB (browser-side, not server-side)

## Privacy & Security

- **No password storage** - Only app passwords are used, never stored
- **No tracking** - No analytics or telemetry
- **No cookies** - Uses IndexedDB for session storage
- **No server storage** - All data and API requests are client-side


### "This account requires authentication"
- The account owner has set their profile to private
- Click "Login" and authenticate with Bluesky

### External Links & Media
- Automatically detects and displays animated media (GIFs, WebP, MP4, WebM)
- Non-media external links show as styled preview cards with:
  - Thumbnail preview
  - Title and domain information

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

### Backend Rate Limiting (Login)
- **5 login attempts per 15 minutes** per IP address
- Prevents brute force attacks
- Uses Memcached (if available) or file-based storage
- Automatic cleanup of expired attempts

### API Rate Limits (Bluesky)
- 30 requests per 5 seconds (per IP)
- 500 requests per 15 minutes (per IP)

The app respects these limits automatically through:
- Batched requests (20 accounts at a time)
- 300ms delays between batches
- 100ms delays between paginated requests

## Disclaimer

This tool is not affiliated with Bluesky or Bluesky Social. Use at your own risk and comply with Bluesky's Terms of Service and API usage policies.