        const API_BASE = 'https://public.api.bsky.app/xrpc';

        class BskyFeedApp {
            constructor() {
                this.DEBUG = false; // Set to true for verbose logging
                this.followedAccounts = [];
                this.feedCursors = new Map();
                this.allPosts = [];
                this.isLoading = false;
                this.displayedCount = 0;
                this.postsPerPage = 100;
                this.sortOrder = localStorage.getItem('sortOrder') || 'ascending';
                this.currentMode = 'following_feed'; // Mode: 'following_feed', 'author_feed', or 'author_likes'
                // Likes lazy-loading
                this.isLikesMode = false;
                this.likesTargetDid = null; // DID of the actor whose likes are being viewed
                this.postUrisToLoad = []; // Array of post URIs awaiting fetch
                this.postCache = new Map(); // Cache for fetched posts
                // Caching
                this.filteredPostsCache = null;
                this.lastFilterParams = null;
                // Scroll position tracking
                this.lastScrollPosition = 0;
                this.lastScrollTimestamp = 0;
                this.positionSavedThisSession = false;
                // Authentication
                this.authToken = null;
                this.userDid = null;
                this.userHandle = null;
                this.refreshToken = null;
                this.refreshInterval = null;
                // Slot awaiting re-login after a token refresh failure (set by promptReauthForAccount)
                this.reauthSlot = null;
                // Multi-account support
                this.accounts = {};
                this.activeAccounts = [];
                // Interaction tracking per account
                this.likedPosts = new Map();
                this.repostedPosts = new Map();
                this.likedPosts_A = new Map();
                this.likedPosts_B = new Map();
                this.repostedPosts_A = new Map();
                this.repostedPosts_B = new Map();
                // Bookmarks are a private per-account toggle (no shareable record URI),
                // so they're tracked as plain URI sets rather than URI → record-URI maps.
                this.bookmarkedPosts = new Set();
                this.bookmarkedPosts_A = new Set();
                this.bookmarkedPosts_B = new Set();
                // PDS discovery cache (in-memory, per session)
                this.pdsCache = new Map();
                // Liked-date map: post URI → ISO date string of when the post was liked
                this.likedAtMap = new Map();
                // Avatar cache: author DID → last-known-good avatar URL, used to backfill
                // posts whose author data arrived without an avatar (rate limiting, partial
                // responses, etc.) and to fix up earlier initials placeholders once a real
                // avatar for that author shows up later in the feed.
                this.avatarCache = new Map();
                this.failedAvatarUrls = new Map();
                // Image preloading
                this.preloadedImages = new Set();
                this.imagePreloadingEnabled = localStorage.getItem('imagePreloadingEnabled') !== 'false'; // true by default
                // Mute/Block filtering
                this.mutedAccounts = new Set();
                this.blockedAccounts = new Set();
                this.muteBlockListLoaded = false;
                this.muteBlockEnabled = localStorage.getItem('muteBlockEnabled') !== 'false'; // true by default
                // Account-grouped layout toggle
                this.accountGroupedLayout = localStorage.getItem('accountGroupedLayout') === 'true';
                // Deduplication toggle (off by default)
                this.deduplicatePosts = localStorage.getItem('deduplicatePosts') === 'true';
                // Prefill target handles with logged-in accounts (off by default)
                this.prefillTargetWithLoggedInAccounts = localStorage.getItem('prefillTargetWithLoggedInAccounts') === 'true';
                // Video volume, persisted and applied to every rendered video
                this.videoVolume = parseFloat(localStorage.getItem('videoVolume'));
                if (isNaN(this.videoVolume)) this.videoVolume = 1;
                this.videoMuted = localStorage.getItem('videoMuted') === 'true';
                // Rate limit tracking (populated from Bluesky response headers)
                this._rateLimitRemaining = null;
                this._rateLimitReset = null;
                // DOM unloading: posts scrolled far behind the live window get collapsed into
                // a single placeholder to cap DOM/memory growth on very long sessions. The
                // underlying post data always stays in allPosts — only rendered DOM is unloaded.
                this.renderedWindowStart = 0; // index into filteredPostsCache of the first still-rendered post
                this.unloadedChunks = []; // stack of {count, height} collapsed chunks, oldest-unloaded first
                this.unloadPlaceholderEl = null;
                this.unloadObserver = null;
                this.UNLOAD_THRESHOLD = 1000; // keep at least this many trailing posts rendered
                this.UNLOAD_CHUNK = 100; // unload/restore this many posts at a time
                this.setupIntersectionObserver();
                this.setupMediaRetryHandler();
                this.setupImagePreloadHandler();
                this.setupVideoVolumeHandler();
                this.setupVideoCleanupObserver();
                this.initializeCacheManager();
                this.cache.init();
                this.setDefaultDateValues();
                this.checkExistingSession();
                this.restoreSortOrderUI();
                this.restoreDarkMode();
                this.restoreMuteBlockUI();
                this.updateLayoutToggleButton();
                this.updateDeduplicateButton();
                this.updatePrefillTargetButton();
            }

            setDefaultDateValues() {
                // Set default start date to today at 00:00 in local timezone.
                // Set default end date to today at 23:59 in local timezone.
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                // Format as YYYY-MM-DDTHH:mm for local datetime (not UTC)
                const year = today.getFullYear();
                const month = String(today.getMonth() + 1).padStart(2, '0');
                const day = String(today.getDate()).padStart(2, '0');
                const hours = String(today.getHours()).padStart(2, '0');
                const minutes = String(today.getMinutes()).padStart(2, '0');

                const dateString = `${year}-${month}-${day}T${hours}:${minutes}`;

                const startInput = document.getElementById('startDateInput');
                if (startInput) startInput.value = dateString;
                
                // Set end date to today at 23:59
                const endToday = new Date();
                endToday.setHours(23, 59, 0, 0);
                const endHours = String(endToday.getHours()).padStart(2, '0');
                const endMinutes = String(endToday.getMinutes()).padStart(2, '0');
                const endDateString = `${year}-${month}-${day}T${endHours}:${endMinutes}`;
                
                const endInput = document.getElementById('endDateInput');
                if (endInput) endInput.value = endDateString;
            }

            getFeedCacheKey(actor, cursor, filter) {
                return `feed:${actor}:${cursor || '0'}:${filter}`;
            }

            getFilterCacheKey() {
                const startDateInput = document.getElementById('startDateInput').value;
                const sortOrder = this.sortOrder;
                return `${startDateInput}:${sortOrder}:${this.deduplicatePosts}:${this.muteBlockEnabled}:${this.muteBlockListLoaded}`;
            }

            getDateRangeFromUI() {
                const startVal = document.getElementById('startDateInput').value;
                const endVal = document.getElementById('endDateInput').value;
                return {
                    startDate: startVal ? new Date(startVal).toISOString() : null,
                    endDate: endVal ? new Date(endVal).toISOString() : null
                };
            }

            initializeCacheManager() {
                this.cache = {
                    db: null,
                    dbName: 'BskyFeedCache',
                    storeName: 'cache',

                    init: async () => {
                        return new Promise((resolve, reject) => {
                            const request = indexedDB.open(this.cache.dbName, 1);

                            request.onerror = () => reject(request.error);
                            request.onsuccess = () => {
                                this.cache.db = request.result;
                                resolve();
                            };

                            request.onupgradeneeded = (event) => {
                                const db = event.target.result;
                                if (!db.objectStoreNames.contains(this.cache.storeName)) {
                                    db.createObjectStore(this.cache.storeName, { keyPath: 'key' });
                                }
                            };
                        });
                    },

                    set: async (key, value, ttl = 3600000) => {
                        if (!this.cache.db) await this.cache.init();
                        return new Promise((resolve, reject) => {
                            const transaction = this.cache.db.transaction([this.cache.storeName], 'readwrite');
                            const store = transaction.objectStore(this.cache.storeName);
                            store.put({
                                key,
                                data: value,
                                timestamp: Date.now(),
                                ttl
                            });
                            transaction.oncomplete = resolve;
                            transaction.onerror = () => reject(transaction.error);
                        });
                    },

                    get: async (key) => {
                        if (!this.cache.db) await this.cache.init();
                        return new Promise((resolve, reject) => {
                            const transaction = this.cache.db.transaction([this.cache.storeName], 'readonly');
                            const store = transaction.objectStore(this.cache.storeName);
                            const request = store.get(key);

                            request.onsuccess = () => {
                                const cached = request.result;
                                if (!cached) {
                                    resolve(null);
                                    return;
                                }

                                if (Date.now() - cached.timestamp > cached.ttl) {
                                    this.cache.delete(key);
                                    resolve(null);
                                } else {
                                    resolve(cached.data);
                                }
                            };
                            request.onerror = () => reject(request.error);
                        });
                    },

                    delete: async (key) => {
                        if (!this.cache.db) await this.cache.init();
                        return new Promise((resolve, reject) => {
                            const transaction = this.cache.db.transaction([this.cache.storeName], 'readwrite');
                            const store = transaction.objectStore(this.cache.storeName);
                            store.delete(key);
                            transaction.oncomplete = resolve;
                            transaction.onerror = () => reject(transaction.error);
                        });
                    },

                    clear: async () => {
                        if (!this.cache.db) await this.cache.init();
                        return new Promise((resolve, reject) => {
                            const transaction = this.cache.db.transaction([this.cache.storeName], 'readwrite');
                            const store = transaction.objectStore(this.cache.storeName);
                            store.clear();
                            transaction.oncomplete = resolve;
                            transaction.onerror = () => reject(transaction.error);
                        });
                    }
                };
            }

            setupIntersectionObserver() {
                const options = {
                    root: null,
                    rootMargin: '0px',
                    threshold: 0
                };

                const observer = new IntersectionObserver((entries) => {
                    if (entries[0].isIntersecting && !this.isLoading && this.allPosts.length > 0) {
                        this.loadNextPage();
                    }
                }, options);

                setTimeout(() => {
                    const sentinel = document.getElementById('sentinel');
                    if (sentinel) observer.observe(sentinel);
                }, 100);
            }

            setupMediaRetryHandler() {
                // 'error' events from <img>/<video> don't bubble, but a capture-phase listener
                // on document still sees them on the way down — use that to detect and
                // auto-retry failed media loads (transient network/CDN blips) application-wide.
                const maxRetries = 3;

                document.addEventListener('error', (e) => {
                    const el = e.target;
                    if (!el || !el.tagName) return;

                    let mediaEl = null;
                    if (el.tagName === 'IMG') {
                        mediaEl = el;
                    } else if (el.tagName === 'VIDEO') {
                        mediaEl = el;
                    } else {
                        return;
                    }

                    const attempts = parseInt(mediaEl.dataset.retryCount || '0', 10);
                    if (attempts >= maxRetries) {
                        if (mediaEl.tagName === 'IMG' && mediaEl.dataset.authorDid) {
                            const avatarUrl = mediaEl.dataset.originalSrc || mediaEl.getAttribute('src');
                            if (avatarUrl) this.failedAvatarUrls.set(avatarUrl, Date.now());
                            const span = document.createElement('span');
                            span.className = 'avatar-initial-fallback';
                            span.dataset.authorDid = mediaEl.dataset.authorDid;
                            span.textContent = mediaEl.dataset.authorInitial || '?';
                            mediaEl.replaceWith(span);
                            return;
                        }
                        mediaEl.classList.add('media-load-failed');
                        mediaEl.title = 'Failed to load after retries';
                        return;
                    }

                    mediaEl.dataset.retryCount = attempts + 1;
                    const delay = 1000 * 2 ** attempts; // 1s, 2s, 4s

                    setTimeout(() => {
                        if (mediaEl.tagName === 'IMG') {
                            const originalSrc = mediaEl.dataset.originalSrc || mediaEl.getAttribute('src');
                            // No real src means the error came from an empty/missing attribute,
                            // not a failed fetch — retrying would just hit this page's own URL.
                            if (!originalSrc) return;
                            mediaEl.dataset.originalSrc = originalSrc;
                            const sep = originalSrc.includes('?') ? '&' : '?';
                            mediaEl.src = `${originalSrc}${sep}_retry=${Date.now()}`;
                        } else {
                            // <video>: plays from a local blob: object URL (see loadAndPlayVideo),
                            // which doesn't support cache-busting query params — just reload it.
                            mediaEl.load();
                        }
                    }, delay);
                }, true); // capture phase required for non-bubbling error events
            }

            setupVideoVolumeHandler() {
                // 'volumechange' doesn't bubble, so use a capture-phase listener to catch it
                // from any video and persist + propagate the chosen level to every other video.
                document.addEventListener('volumechange', (e) => {
                    const video = e.target;
                    if (!video || video.tagName !== 'VIDEO') return;

                    this.videoVolume = video.volume;
                    this.videoMuted = video.muted;
                    localStorage.setItem('videoVolume', this.videoVolume);
                    localStorage.setItem('videoMuted', this.videoMuted);

                    document.querySelectorAll('video').forEach(v => {
                        if (v !== video) {
                            v.volume = this.videoVolume;
                            v.muted = this.videoMuted;
                        }
                    });
                }, true);
            }

            applyVideoVolume(video) {
                video.volume = this.videoVolume;
                video.muted = this.videoMuted;
            }

            setupVideoCleanupObserver() {
                // Click-to-load videos are played from a blob: object URL (see loadAndPlayVideo)
                // so they must be revoked once removed, or every feed clear/reload leaks memory.
                // A MutationObserver on #feed catches removals from every call site (innerHTML
                // resets, pagination, mode switches) without needing to touch each one.
                const feed = document.getElementById('feed');
                if (!feed) return;
                const observer = new MutationObserver((mutations) => {
                    for (const mutation of mutations) {
                        mutation.removedNodes.forEach((node) => {
                            if (node.nodeType !== Node.ELEMENT_NODE) return;
                            const videos = node.matches('video[data-object-url]')
                                ? [node]
                                : node.querySelectorAll('video[data-object-url]');
                            videos.forEach((v) => URL.revokeObjectURL(v.dataset.objectUrl));
                        });
                    }
                });
                observer.observe(feed, { childList: true, subtree: true });
            }

            async loadAndPlayVideo(placeholderEl) {
                // Videos are only fetched on click (not preloaded with the rest of the feed).
                // The whole blob is downloaded up front and played from a local object URL
                // instead of streaming straight from the PDS, because com.atproto.sync.getBlob
                // doesn't support HTTP Range requests — native <video> seeking needs the browser
                // to be able to request arbitrary byte ranges, so without this, dragging the
                // scrubber silently fails. A fully-downloaded blob: URL is seekable locally.
                const container = placeholderEl.closest('.post-video');
                if (!container || container.dataset.loading === 'true') return;
                container.dataset.loading = 'true';

                const did = container.dataset.authorDid;
                const cid = container.dataset.videoCid;
                placeholderEl.innerHTML = '<span class="video-status">Loading video…</span>';

                try {
                    await this.discoverPds(did);
                    const response = await fetch(this.getBlobUrl(did, cid));
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const blob = await response.blob();
                    const objectUrl = URL.createObjectURL(blob);

                    const video = document.createElement('video');
                    video.controls = true;
                    video.autoplay = true;
                    video.src = objectUrl;
                    video.dataset.objectUrl = objectUrl;
                    this.applyVideoVolume(video);

                    container.innerHTML = '';
                    container.appendChild(video);
                } catch (error) {
                    console.warn(`Video load failed for ${did}/${cid}:`, error);
                    placeholderEl.innerHTML = '<span class="video-status video-status-error">Failed to load video — tap to retry</span>';
                    container.dataset.loading = 'false';
                }
            }

            updateStatus(message) {
                document.getElementById('statusInfo').textContent = message;
            }

            addHandleInput() {
                const container = document.getElementById('handlesContainer');
                const row = document.createElement('div');
                row.className = 'handle-input-row';
                row.style.cssText = 'display: flex; gap: 8px; align-items: center;';
                
                const newInput = document.createElement('input');
                newInput.type = 'text';
                newInput.className = 'handleInput';
                newInput.placeholder = 'Enter Bluesky handle';
                
                const removeBtn = document.createElement('button');
                removeBtn.textContent = '✕';
                removeBtn.style.cssText = 'padding: 8px 12px; background-color: #e74c3c; border: none; border-radius: 4px; color: white; cursor: pointer; font-size: 14px; white-space: nowrap;';
                removeBtn.onclick = () => row.remove();
                
                row.appendChild(newInput);
                row.appendChild(removeBtn);
                container.appendChild(row);
                newInput.focus();
            }

            getTargetHandles() {
                const inputs = document.querySelectorAll('.handleInput');
                const handles = [];
                inputs.forEach(input => {
                    const handle = input.value.trim();
                    if (handle) handles.push(handle);
                });
                return handles;
            }

            deduplicateFollows(followsArray) {
                const seen = new Set();
                const deduplicated = [];
                
                followsArray.forEach(account => {
                    // Use DID as unique identifier since it's immutable
                    const key = account.did;
                    if (!seen.has(key)) {
                        seen.add(key);
                        deduplicated.push(account);
                    }
                });
                
                return deduplicated;
            }

            async checkExistingSession() {
                // Check for multi-account setup first
                const activeAccounts = await this.cache.get('auth:activeAccounts');
                
                if (activeAccounts && Array.isArray(activeAccounts) && activeAccounts.length > 0) {
                    // Multi-account mode
                    this.activeAccounts = activeAccounts;
                    for (const slot of activeAccounts) {
                        const token = await this.cache.get(`auth:token:${slot}`);
                        const did = await this.cache.get(`auth:did:${slot}`);
                        const handle = await this.cache.get(`auth:handle:${slot}`);
                        const refreshToken = await this.cache.get(`auth:refresh:${slot}`);
                        
                        if (token && did && handle && refreshToken) {
                            this.accounts[slot] = { token, did, handle, refreshToken };
                        }
                    }
                    
                    // Set primary account for backward compatibility
                    if (this.activeAccounts.length > 0) {
                        const primarySlot = this.activeAccounts[0];
                        this.authToken = this.accounts[primarySlot].token;
                        this.userDid = this.accounts[primarySlot].did;
                        this.userHandle = this.accounts[primarySlot].handle;
                        this.refreshToken = this.accounts[primarySlot].refreshToken;
                    }
                } else {
                    // Fall back to single account mode (legacy)
                    const token = await this.cache.get('auth:token');
                    const did = await this.cache.get('auth:did');
                    const handle = await this.cache.get('auth:handle');
                    const refreshToken = await this.cache.get('auth:refresh');

                    if (token && did && handle && refreshToken) {
                        this.authToken = token;
                        this.userDid = did;
                        this.userHandle = handle;
                        this.refreshToken = refreshToken;
                    }
                }
                
                if (this.authToken) {
                    this.updateAuthUI();
                    this.setupTokenRefresh();
                    await this.loadInteractionState();
                    this.prefillTargetHandlesWithLoggedInAccounts();
                }
            }

            async loadInteractionState() {
                // Load liked/reposted/bookmarked posts for each active account
                for (const slot of this.activeAccounts) {
                    const likedKey = `liked:${slot}`;
                    const repostedKey = `reposted:${slot}`;
                    const bookmarkedKey = `bookmarked:${slot}`;
                    
                    const liked = await this.cache.get(likedKey);
                    const reposted = await this.cache.get(repostedKey);
                    const bookmarked = await this.cache.get(bookmarkedKey);
                    
                    const { likedMap: targetMap_liked, repostedMap: targetMap_reposted, bookmarkedSet: targetSet_bookmarked } = this.getMapsForSlot(slot);
                    
                    if (liked) {
                        Object.entries(liked).forEach(([uri, recordUri]) => {
                            targetMap_liked.set(uri, recordUri);
                        });
                    }
                    if (reposted) {
                        Object.entries(reposted).forEach(([uri, recordUri]) => {
                            targetMap_reposted.set(uri, recordUri);
                        });
                    }
                    if (bookmarked) {
                        bookmarked.forEach(uri => targetSet_bookmarked.add(uri));
                    }
                }
            }

            async saveInteractionState(slot) {
                const { likedMap: targetMap_liked, repostedMap: targetMap_reposted, bookmarkedSet: targetSet_bookmarked } = this.getMapsForSlot(slot);
                
                const likedObj = {};
                targetMap_liked.forEach((value, key) => {
                    likedObj[key] = value;
                });
                
                const repostedObj = {};
                targetMap_reposted.forEach((value, key) => {
                    repostedObj[key] = value;
                });
                
                const likedKey = `liked:${slot}`;
                const repostedKey = `reposted:${slot}`;
                const bookmarkedKey = `bookmarked:${slot}`;
                
                await this.cache.set(likedKey, likedObj, 24 * 3600 * 1000);
                await this.cache.set(repostedKey, repostedObj, 24 * 3600 * 1000);
                await this.cache.set(bookmarkedKey, Array.from(targetSet_bookmarked), 24 * 3600 * 1000);
            }

            updateAuthUI() {
                const loginBtn = document.getElementById('loginBtn');
                const authSection = document.getElementById('authSection');
                const loggedInUser = document.getElementById('loggedInUser');

                if (this.authToken) {
                    loginBtn.style.display = 'none';
                    authSection.style.display = 'flex';
                    if (this.activeAccounts.length > 0) {
                        const accountLabels = this.activeAccounts.map(slot => 
                            this.accounts[slot] ? `${slot}: ${this.accounts[slot].handle}` : slot
                        ).join(' + ');
                        loggedInUser.textContent = `👤 ${accountLabels}`;
                    } else {
                        loggedInUser.textContent = `👤 ${this.userHandle}`;
                    }
                } else {
                    loginBtn.style.display = 'block';
                    authSection.style.display = 'none';
                }
            }

            setupTokenRefresh() {
                // Refresh tokens every 90 minutes (before 2-hour expiry)
                if (this.refreshInterval) {
                    clearInterval(this.refreshInterval);
                }

                this.refreshInterval = setInterval(() => {
                    this.refreshAuthTokenMultiAccount();
                }, 90 * 60 * 1000);

                console.log('✅ Token refresh scheduled for every 90 minutes for all active accounts');
            }

            async refreshAuthTokenMultiAccount() {
                // Refresh tokens for all active accounts
                for (const slot of this.activeAccounts) {
                    const account = this.accounts[slot];
                    if (!account || !account.refreshToken) {
                        console.warn(`No refresh token available for account ${slot}`);
                        continue;
                    }

                    const refreshed = await this.refreshAccountTokenWithRetry(slot, account);
                    if (!refreshed) {
                        // Leave the account, its slot, and all cached like/repost/bookmark data
                        // untouched — only the token is stale. Just ask the user to log back in.
                        this.promptReauthForAccount(slot);
                    }
                }
            }

            async refreshAccountTokenWithRetry(slot, account, maxRetries = 2) {
                for (let attempt = 0; attempt <= maxRetries; attempt++) {
                    try {
                        const response = await fetch('https://bsky.social/xrpc/com.atproto.server.refreshSession', {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${account.refreshToken}`
                            }
                        });

                        if (!response.ok) {
                            throw new Error(`HTTP ${response.status}`);
                        }

                        const data = await response.json();
                        account.token = data.accessJwt;
                        if (data.refreshJwt) {
                            account.refreshToken = data.refreshJwt;
                        }

                        // Update cache
                        await this.cache.set(`auth:token:${slot}`, account.token, 24 * 3600 * 1000);
                        await this.cache.set(`auth:refresh:${slot}`, account.refreshToken, 24 * 3600 * 1000);

                        // Update primary token if this is the first account
                        if (slot === this.activeAccounts[0]) {
                            this.authToken = account.token;
                            this.refreshToken = account.refreshToken;
                        }

                        console.log(`✅ Token refreshed successfully for account ${slot}`);
                        return true;
                    } catch (error) {
                        const isLastAttempt = attempt === maxRetries;
                        console.warn(`Token refresh attempt ${attempt + 1}/${maxRetries + 1} failed for account ${slot}:`, error);
                        if (!isLastAttempt) {
                            await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt)); // 1s, 2s
                        }
                    }
                }
                console.error(`Token refresh failed for account ${slot} after ${maxRetries + 1} attempts`);
                return false;
            }

            promptReauthForAccount(slot) {
                // Refresh exhausted its retries — the refresh token is likely expired/revoked.
                // Ask the user to log back in for this exact slot without clearing anything else.
                const account = this.accounts[slot];
                if (!account) return;

                this.updateStatus(`⚠️ Session expired for ${account.handle} — please log in again.`);

                // Avoid yanking the modal back open on every 90-minute retry if the user already
                // dismissed it for this slot; the status message above still reflects the issue.
                if (this.reauthSlot === slot) return;

                this.showLoginModal();

                const handleInput = document.getElementById('loginHandle');
                if (handleInput) handleInput.value = account.handle;

                const errorDiv = document.getElementById('loginError');
                if (errorDiv) {
                    errorDiv.textContent = `Your session for ${account.handle} expired. Please re-enter your app password.`;
                    errorDiv.style.display = 'block';
                }

                // Consumed by attemptLogin so re-login reuses this slot instead of adding a new one
                this.reauthSlot = slot;
            }

            showLoginModal() {
                document.getElementById('loginModal').style.display = 'flex';
                // Ensure input fields are visible when modal opens
                const loginFormInputs = document.getElementById('loginFormInputs');
                const postAccountDiv = document.getElementById('loginPostAccountDiv');
                if (loginFormInputs) loginFormInputs.style.display = 'block';
                if (postAccountDiv) postAccountDiv.style.display = 'none';
            }

            hideLoginModal() {
                document.getElementById('loginModal').style.display = 'none';
                document.getElementById('loginError').style.display = 'none';
            }

            showLoadPostModal() {
                document.getElementById('loadPostModal').style.display = 'block';
                document.getElementById('postUrlInput').value = '';
                document.getElementById('loadPostError').style.display = 'none';
                document.getElementById('postUrlInput').focus();
            }

            hideLoadPostModal() {
                document.getElementById('loadPostModal').style.display = 'none';
                document.getElementById('loadPostError').style.display = 'none';
            }

            async loadSinglePost() {
                const input = document.getElementById('postUrlInput').value.trim();
                const errorDiv = document.getElementById('loadPostError');

                if (!input) {
                    errorDiv.textContent = 'Please enter a post URL or ID';
                    errorDiv.style.display = 'block';
                    return;
                }

                try {
                    errorDiv.style.display = 'none';
                    this.updateStatus('Loading post...');

                    // Parse the input to extract URI
                    let postUri = input;
                    if (input.startsWith('http')) {
                        // Extract from URL like https://bsky.app/profile/did:plc:.../post/abc123
                        const match = input.match(/profile\/([^/]+)\/post\/([^/]+)/);
                        if (match) {
                            postUri = `at://${match[1]}/app.bsky.feed.post/${match[2]}`;
                        }
                    }

                    // Fetch post details — use the authenticated endpoint (and primary account's
                    // token) when logged in so post.viewer reflects actual like/repost/bookmark state
                    const primarySlot = this.activeAccounts.length > 0 ? this.activeAccounts[0] : null;
                    const primaryToken = primarySlot ? this.accounts[primarySlot]?.token : this.authToken;
                    const threadBase = primaryToken ? 'https://bsky.social/xrpc' : API_BASE;

                    const response = await this.bskyFetch(`${threadBase}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(postUri)}&depth=2&height=2`, {
                        headers: primaryToken ? { 'Authorization': `Bearer ${primaryToken}` } : {}
                    });

                    if (!response.ok) {
                        throw new Error('Post not found');
                    }

                    const data = await response.json();
                    const post = data.thread.post;
                    const parentPost = data.thread.parent?.post || null;

                    // Capture like/repost/bookmark state for the primary account
                    this.extractSinglePostViewerData(post, primarySlot);
                    if (parentPost) this.extractSinglePostViewerData(parentPost, primarySlot);

                    // In multi-account mode, re-fetch with each secondary account's own token so
                    // their like/repost/bookmark state shows accurately too (post.viewer is
                    // scoped to whichever account's token made the request)
                    for (let i = 1; i < this.activeAccounts.length; i++) {
                        const slot = this.activeAccounts[i];
                        const token = this.accounts[slot]?.token;
                        if (!token) continue;

                        try {
                            const secResponse = await this.bskyFetch(
                                `https://bsky.social/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(postUri)}&depth=0&height=1`,
                                { headers: { 'Authorization': `Bearer ${token}` } }
                            );
                            if (secResponse.ok) {
                                const secData = await secResponse.json();
                                this.extractSinglePostViewerData(secData.thread?.post, slot);
                                if (secData.thread?.parent?.post) {
                                    this.extractSinglePostViewerData(secData.thread.parent.post, slot);
                                }
                            }
                        } catch (err) {
                            console.warn(`Failed to load viewer state for account ${slot}:`, err);
                        }
                    }

                    // Reset feed state and display single post
                    this.resetFeedState();
                    // Mark post as debug post so it won't be filtered by date restrictions
                    this.allPosts = [{
                        post: post,
                        reply: data.thread.parent ? { parent: parentPost } : null,
                        isDebugPost: true
                    }];
                    this.followedAccounts = [{did: post.author.did, handle: post.author.handle}];
                    
                    // Clear date input to ensure no date filtering
                    const startDateInput = document.getElementById('startDateInput');
                    if (startDateInput) startDateInput.value = '';

                    this.renderPage();
                    this.hideLoadPostModal();
                    this.updateStatus('Post loaded successfully (debug mode - ignoring all restrictions)');
                } catch (error) {
                    errorDiv.textContent = `Error: ${error.message}`;
                    errorDiv.style.display = 'block';
                    this.updateStatus(`Error loading post: ${error.message}`);
                }
            }

            extractSinglePostViewerData(post, viewerSlot = null) {
                // Stores like/repost/bookmark state for one postView into the right account's
                // maps — shared by fetchPostByUri (likes mode) and the debug "Load Post" path.
                if (!post || !post.viewer) return;

                if (this.activeAccounts.length >= 2) {
                    const resolvedViewerSlot = viewerSlot || this.activeAccounts[0];
                    const { likedMap, repostedMap, bookmarkedSet } = this.getMapsForSlot(resolvedViewerSlot);
                    if (post.viewer.like) likedMap.set(post.uri, post.viewer.like);
                    if (post.viewer.repost) repostedMap.set(post.uri, post.viewer.repost);
                    if (post.viewer.bookmarked) bookmarkedSet.add(post.uri);
                } else if (this.activeAccounts.length === 1 || this.authToken) {
                    const singleSlot = this.activeAccounts.length === 1 ? this.activeAccounts[0] : null;
                    const { likedMap, repostedMap, bookmarkedSet } = this.getMapsForSlot(singleSlot);
                    if (post.viewer.like) likedMap.set(post.uri, post.viewer.like);
                    if (post.viewer.repost) repostedMap.set(post.uri, post.viewer.repost);
                    if (post.viewer.bookmarked) bookmarkedSet.add(post.uri);
                }
            }

            async fetchPostByUri(uri, attempt = 0) {
                // Check cache first
                if (this.postCache.has(uri)) {
                    return this.postCache.get(uri);
                }

                const maxAttempts = 3;

                try {
                    // In likes mode with multiple accounts, use the viewer (non-target) account's token
                    let fetchToken = this.authToken;
                    let viewerSlot = null;
                    if (this.isLikesMode && this.likesTargetDid && this.activeAccounts.length >= 2) {
                        const targetSlot = this.getSlotForActor(this.likesTargetDid);
                        viewerSlot = this.activeAccounts.find(s => s !== targetSlot) || null;
                        if (viewerSlot && this.accounts[viewerSlot]) {
                            fetchToken = this.accounts[viewerSlot].token;
                        }
                    }
                    const headers = fetchToken ? { 'Authorization': `Bearer ${fetchToken}` } : {};
                    const threadBase = fetchToken ? 'https://bsky.social/xrpc' : API_BASE;

                    const response = await this.bskyFetch(
                        `${threadBase}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&height=0`,
                        { headers }
                    );

                    if (response.ok) {
                        const postThread = await response.json();
                        if (postThread.thread?.post) {
                            const post = postThread.thread.post;
                            
                            // Debug: log viewer data
                            if (this.DEBUG) {
                                console.log(`[fetchPostByUri] Post ${uri}:`, {
                                    hasViewer: !!post.viewer,
                                    viewer: post.viewer,
                                    activeAccounts: this.activeAccounts,
                                    viewerSlot
                                });
                            }
                            
                            this.extractSinglePostViewerData(post, viewerSlot);
                            
                            this.postCache.set(uri, post);
                            return post;
                        }
                    }
                } catch (error) {
                    if (attempt < maxAttempts - 1) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
                        return this.fetchPostByUri(uri, attempt + 1);
                    }
                    console.warn(`Failed to fetch post ${uri} after ${maxAttempts} attempts:`, error);
                    return null;
                }

                // Response came back but wasn't ok/usable — retry before giving up
                if (attempt < maxAttempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
                    return this.fetchPostByUri(uri, attempt + 1);
                }
                console.warn(`Failed to fetch post ${uri} after ${maxAttempts} attempts`);
                return null;
            }

            async retryPostPlaceholder(uri) {
                // Manual retry triggered from the "Failed to load post" button
                const el = document.querySelector(`[data-post-uri="${CSS.escape(uri)}"]`);
                if (el) el.innerHTML = '<div style="padding: 16px; color: #888;">Loading post...</div>';

                const post = await this.fetchPostByUri(uri);
                const toReplace = document.querySelector(`[data-post-uri="${CSS.escape(uri)}"]`);
                if (!toReplace) return;

                if (post) {
                    const newEl = this.createPostElementFromData(post, {});
                    toReplace.replaceWith(newEl);
                    this.resolvePendingImageSources(newEl);
                } else {
                    toReplace.innerHTML = `<div style="padding: 16px; color: #e0245e; display: flex; align-items: center; gap: 10px;">
                        ⚠️ Failed to load post.
                        <button onclick="app.retryPostPlaceholder('${uri.replace(/'/g, "\\'")}')" style="padding: 4px 10px; cursor: pointer;">Retry</button>
                    </div>`;
                }
            }

            createPostElementFromData(post, item) {
                const author = post.author;
                const record = post.record;

                const postEl = document.createElement('div');
                // Add reply class if this is a reply
                postEl.className = (record.reply && record.reply.parent) ? 'post post-is-reply' : 'post';
                postEl.setAttribute('data-post-uri', post.uri);

                const postDate = new Date(record.createdAt);
                const timeAgo = this.formatTimeAgo(postDate);
                const fullDate = postDate.toLocaleString();
                const avatarHtml = this.getAvatarHtml(author);

                // Extract images (same logic as main rendering)
                let imagesHtml = '';
                let imagesToProcess = [];

                if (record.embed && record.embed.$type === 'app.bsky.embed.recordWithMedia' && record.embed.media && record.embed.media.images) {
                    imagesToProcess = record.embed.media.images;
                } else if (record.embed && record.embed.images && record.embed.images.length > 0) {
                    imagesToProcess = record.embed.images;
                }

                if (imagesToProcess.length > 0) {
                    imagesHtml = `<div class="post-images">`;
                    const imageUrls = this.extractImageUrls(imagesToProcess, author.did);
                    imagesToProcess.forEach((img, index) => {
                        let imageUrl = imageUrls[index];
                        const alt = img.alt || 'Post image';
                        if (imageUrl) {
                            imagesHtml += `<img src="${imageUrl}" alt="${alt}" class="post-image" onclick="app.openImageModalFromEl(this)" />`;
                        } else if (img.image?.ref?.$link) {
                            // Author's PDS isn't known yet — resolved async, see resolvePendingImageSources
                            imagesHtml += `<img alt="${alt}" class="post-image" data-author-did="${author.did}" data-image-cid="${img.image.ref.$link}" onclick="app.openImageModalFromEl(this)" />`;
                        }
                    });
                    imagesHtml += '</div>';
                }

                postEl.innerHTML = `
                    <div class="post-header">
                        <a href="https://bsky.app/profile/${author.did}" class="post-avatar-link" target="_blank" rel="noopener noreferrer">
                            <div class="post-avatar">${avatarHtml}</div>
                        </a>
                        <div class="post-info">
                            <div>
                                <a href="https://bsky.app/profile/${author.did}" class="post-author-link" target="_blank" rel="noopener noreferrer">
                                    <span class="post-author">${author.displayName || author.handle}</span>
                                    <span class="post-handle">@${author.handle}</span>
                                </a>
                                <span class="post-time">
                                    <a href="https://bsky.app/profile/${author.did}/post/${post.uri.split('/').pop()}" class="post-timestamp" title="${fullDate}" target="_blank" rel="noopener noreferrer">${timeAgo}</a>
                                </span>
                            </div>
                        </div>
                    </div>
                    <a href="https://bsky.app/profile/${author.did}/post/${post.uri.split('/').pop()}" class="post-link" target="_blank" rel="noopener noreferrer">
                        <div class="post-text">${this.breakLongWords(record.text)}</div>
                    </a>
                    ${imagesHtml}
                    ${this.generatePostStats(post.uri, post.cid, post.replyCount, post.likeCount, post.repostCount)}
                `;

                return postEl;
            }

            async loadDebugFeedsForViewerData(actor) {
                // Load viewer data for author feed mode with secondary accounts (skip primary).
                // Must use each account's own token and respect the date range.
                const { startDate, endDate } = this.getDateRangeFromUI();

                for (let idx = 1; idx < this.activeAccounts.length; idx++) {
                    const slot = this.activeAccounts[idx];
                    const account = this.accounts[slot];
                    if (!account) continue;

                    try {
                        await this.getAuthorFeedWithDateRangeForAccount(actor, endDate, startDate, 'posts_with_replies', slot);
                        this.updateStatus(`✅ Loaded interaction state for account ${slot}`);
                    } catch (error) {
                        console.warn(`Error loading feed for account ${slot}:`, error);
                    }
                }
            }

            resetFeedState() {
                this.displayedCount = 0;
                this.filteredPostsCache = null;
                this.lastFilterParams = null;
                this.isLikesMode = false;
                this.likesTargetDid = null;
                this.likedAtMap = new Map();
                this.clearFeedDOM();
            }

            // Clears the feed DOM and resets the DOM-unloading window state that tracks it.
            clearFeedDOM() {
                document.getElementById('feed').innerHTML = '';
                this.renderedWindowStart = 0;
                this.unloadedChunks = [];
                this.unloadPlaceholderEl = null;
                if (this.unloadObserver) {
                    this.unloadObserver.disconnect();
                    this.unloadObserver = null;
                }
            }

            async attemptLogin(accountSlot = null) {
                const handle = document.getElementById('loginHandle').value.trim();
                const password = document.getElementById('loginPassword').value.trim();
                const errorDiv = document.getElementById('loginError');

                if (!handle || !password) {
                    errorDiv.textContent = 'Please enter handle/email and app password';
                    errorDiv.style.display = 'block';
                    return;
                }

                try {
                    errorDiv.style.display = 'none';

                    const response = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            identifier: handle,
                            password: password
                        })
                    });

                    if (!response.ok) {
                        throw new Error('Invalid credentials');
                    }

                    const data = await response.json();

                    // Determine which slot to use — reuse the slot awaiting re-auth (if any)
                    // after a failed token refresh, so like/repost/bookmark maps aren't disturbed
                    let slot = accountSlot || this.reauthSlot;
                    if (!slot) {
                        // First login - use 'A'
                        if (this.activeAccounts.length === 0) {
                            slot = 'A';
                        } else {
                            // Second login - use 'B'
                            slot = 'B';
                        }
                    }
                    this.reauthSlot = null;

                    // Store account
                    this.accounts[slot] = {
                        token: data.accessJwt,
                        did: data.did,
                        handle: data.handle,
                        refreshToken: data.refreshJwt
                    };

                    // Add to active accounts if not already there
                    if (!this.activeAccounts.includes(slot)) {
                        this.activeAccounts.push(slot);
                    }

                    // Cache multi-account data
                    await this.cache.set(`auth:token:${slot}`, data.accessJwt, 24 * 3600 * 1000);
                    await this.cache.set(`auth:did:${slot}`, data.did, 24 * 3600 * 1000);
                    await this.cache.set(`auth:handle:${slot}`, data.handle, 24 * 3600 * 1000);
                    await this.cache.set(`auth:refresh:${slot}`, data.refreshJwt, 24 * 3600 * 1000);
                    await this.cache.set('auth:activeAccounts', this.activeAccounts, 24 * 3600 * 1000);

                    // Update primary account tokens for backward compatibility
                    // Only update when this slot IS the primary account; logging in as a
                    // secondary account (slot B) must not overwrite A's token, otherwise
                    // Phase-1 feed fetches would use B's token but store viewer data in A's maps.
                    if (slot === this.activeAccounts[0]) {
                        this.authToken = data.accessJwt;
                        this.userDid = data.did;
                        this.userHandle = data.handle;
                        this.refreshToken = data.refreshJwt;
                    }

                    this.updateAuthUI();
                    this.prefillTargetHandlesWithLoggedInAccounts();
                    
                    // Show option to add second account if only one is logged in
                    if (this.activeAccounts.length === 1 && slot === 'A') {
                        this.showAddAccountOption();
                    } else {
                        this.hideLoginModal();
                        this.setupTokenRefresh();
                    }

                    // Clear login fields
                    document.getElementById('loginHandle').value = '';
                    document.getElementById('loginPassword').value = '';
                } catch (error) {
                    errorDiv.textContent = `Login failed: ${error.message}`;
                    errorDiv.style.display = 'block';
                }
            }

            async logout() {
                // Logout all accounts
                const accountSlots = [...this.activeAccounts];
                for (const slot of accountSlots) {
                    await this.logoutAccount(slot);
                }
                
                if (this.refreshInterval) {
                    clearInterval(this.refreshInterval);
                    this.refreshInterval = null;
                }

                this.authToken = null;
                this.refreshToken = null;
                this.userDid = null;
                this.userHandle = null;
                this.accounts = {};
                this.activeAccounts = [];
                this.likedPosts.clear();
                this.repostedPosts.clear();
                this.likedPosts_A.clear();
                this.likedPosts_B.clear();
                this.repostedPosts_A.clear();
                this.repostedPosts_B.clear();
                this.bookmarkedPosts.clear();
                this.bookmarkedPosts_A.clear();
                this.bookmarkedPosts_B.clear();

                await this.cache.delete('auth:token');
                await this.cache.delete('auth:did');
                await this.cache.delete('auth:handle');
                await this.cache.delete('auth:refresh');
                await this.cache.delete('auth:activeAccounts');

                this.updateAuthUI();
            }

            async logoutAccount(slot) {
                // Logout a specific account
                if (this.accounts[slot]) {
                    delete this.accounts[slot];
                }

                // Remove from active accounts
                this.activeAccounts = this.activeAccounts.filter(s => s !== slot);

                // Clear cache for this account
                await this.cache.delete(`auth:token:${slot}`);
                await this.cache.delete(`auth:did:${slot}`);
                await this.cache.delete(`auth:handle:${slot}`);
                await this.cache.delete(`auth:refresh:${slot}`);
                await this.cache.delete(`liked:${slot}`);
                await this.cache.delete(`reposted:${slot}`);
                await this.cache.delete(`bookmarked:${slot}`);

                // Clear interaction maps for this account
                if (slot === 'A') {
                    this.likedPosts_A.clear();
                    this.repostedPosts_A.clear();
                    this.bookmarkedPosts_A.clear();
                } else if (slot === 'B') {
                    this.likedPosts_B.clear();
                    this.repostedPosts_B.clear();
                    this.bookmarkedPosts_B.clear();
                }

                // Update primary account if this was the primary
                if (this.activeAccounts.length > 0) {
                    const newPrimary = this.activeAccounts[0];
                    this.authToken = this.accounts[newPrimary].token;
                    this.userDid = this.accounts[newPrimary].did;
                    this.userHandle = this.accounts[newPrimary].handle;
                    this.refreshToken = this.accounts[newPrimary].refreshToken;
                } else {
                    this.authToken = null;
                    this.userDid = null;
                    this.userHandle = null;
                    this.refreshToken = null;
                }

                // Update cache
                if (this.activeAccounts.length > 0) {
                    await this.cache.set('auth:activeAccounts', this.activeAccounts, 24 * 3600 * 1000);
                } else {
                    await this.cache.delete('auth:activeAccounts');
                }

                this.updateAuthUI();
            }

            showAddAccountOption() {
                // Show modal with option to continue or add another account
                const postAccountDiv = document.getElementById('loginPostAccountDiv');
                const loginFormInputs = document.getElementById('loginFormInputs');
                const addBtn = document.querySelector('.login-add-btn');
                const continueBtn = document.querySelector('.login-continue-btn');
                
                // Hide input fields, show post-account options
                if (loginFormInputs) loginFormInputs.style.display = 'none';
                if (postAccountDiv) postAccountDiv.style.display = 'block';
                if (addBtn) addBtn.style.display = 'inline-block';
                if (continueBtn) continueBtn.style.display = 'inline-block';
            }

            prepareAddSecondAccount() {
                // Prepare the form for adding a second account
                const loginFormInputs = document.getElementById('loginFormInputs');
                const postAccountDiv = document.getElementById('loginPostAccountDiv');
                
                // Show input fields, hide post-account options
                if (loginFormInputs) loginFormInputs.style.display = 'block';
                if (postAccountDiv) postAccountDiv.style.display = 'none';
                
                // Reset form and placeholders
                document.getElementById('loginHandle').value = '';
                document.getElementById('loginPassword').value = '';
                document.getElementById('loginHandle').placeholder = 'Second account handle';
                document.getElementById('loginPassword').placeholder = '(app password for second account)';
                
                // Clear errors
                document.getElementById('loginError').style.display = 'none';
                
                // Focus on handle input
                document.getElementById('loginHandle').focus();
            }

            updateFeedStats() {
                const stats = document.getElementById('feedStats');
                const statsText = document.getElementById('feedStatsText');
                if (this.followedAccounts.length > 0) {
                    let statsStr = `👥 Following ${this.followedAccounts.length} accounts | 📮 Collected ${this.allPosts.length} posts | 👀 Displaying ${this.displayedCount} posts`;
                    if (this.muteBlockEnabled && this.muteBlockListLoaded) {
                        const totalMuteBlock = this.mutedAccounts.size + this.blockedAccounts.size;
                        statsStr += ` | 🚫 Filtered ${totalMuteBlock} accounts`;
                    }
                    statsText.textContent = statsStr;
                    stats.style.display = 'flex';
                    document.body.classList.add('feed-stats-visible');
                } else {
                    stats.style.display = 'none';
                    document.body.classList.remove('feed-stats-visible');
                }
            }

            restoreSortOrderUI() {
                const sortSelect = document.getElementById('sortSelect');
                if (sortSelect) {
                    sortSelect.value = this.sortOrder;
                }
            }

            setSortOrder(order) {
                this.sortOrder = order;
                localStorage.setItem('sortOrder', order);
                this.displayedCount = 0;
                this.clearFeedDOM();
                this.renderPage();
            }

            setMode(mode) {
                this.currentMode = mode;
                this.displayedCount = 0;
                this.clearFeedDOM();
                document.getElementById('feedStats').style.display = 'none';
                document.body.classList.remove('feed-stats-visible');
            }

            toggleMenu() {
                const menu = document.getElementById('dropdownMenu');
                const isOpen = menu.style.display !== 'none';
                menu.style.display = isOpen ? 'none' : 'block';

                if (!isOpen) {
                    // Close menu when clicking elsewhere — attach once so it self-removes
                    document.addEventListener('click', (e) => {
                        if (e.target.id !== 'menuToggle' && e.target.closest('#dropdownMenu') === null) {
                            menu.style.display = 'none';
                        }
                    }, { once: true });
                }
            }

            scrollToTop() {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }

            async clearCache() {
                try {
                    // Clear the cache store
                    this.updateStatus('🧹 Clearing cache store...');
                    await this.cache.clear();
                    
                    // Close the database connection before deleting
                    if (this.cache.db) {
                        this.cache.db.close();
                        this.cache.db = null;
                    }
                    
                    // Delete the entire database with timeout
                    this.updateStatus('🧹 Deleting IndexedDB database...');
                    
                    await Promise.race([
                        new Promise((resolve, reject) => {
                            const deleteRequest = indexedDB.deleteDatabase(this.cache.dbName);
                            
                            deleteRequest.onsuccess = () => {
                                resolve();
                            };
                            
                            deleteRequest.onerror = () => {
                                reject(deleteRequest.error);
                            };
                            
                            deleteRequest.onblocked = () => {
                                console.warn('⚠️ Database deletion blocked - close other tabs with this site open');
                            };
                        }),
                        new Promise((resolve, reject) => {
                            setTimeout(() => {
                                resolve();
                            }, 5000);
                        })
                    ]);
                    
                    // Reinitialize database
                    this.updateStatus('🧹 Reinitializing database...');
                    this.cache.db = null;
                    await this.cache.init();
                    
                    // Reset UI state
                    this.updateStatus('🧹 Resetting UI state...');
                    this.followedAccounts = [];
                    this.feedCursors = new Map();
                    this.allPosts = [];
                    this.displayedCount = 0;
                    this.clearFeedDOM();
                    document.getElementById('feedStats').style.display = 'none';
                    document.body.classList.remove('feed-stats-visible');
                    
                    this.updateStatus('✅ Cache cleared successfully');
                    alert('Cache cleared! You can load a new feed.');
                } catch (error) {
                    console.error('❌ [Cache Clear] Error clearing cache:', error);
                    this.updateStatus(`❌ Error clearing cache: ${error.message}`);
                }
            }

            async loadFeed() {
                const handles = this.getTargetHandles();
                
                if (handles.length === 0) {
                    alert('Please enter at least one Bluesky handle');
                    return;
                }

                // Sync mode from DOM in case setMode() was never called
                this.currentMode = document.getElementById('modeSelect').value;

                this.followedAccounts = [];
                this.feedCursors = new Map();
                this.allPosts = [];
                this.displayedCount = 0;

                this.clearFeedDOM();
                document.getElementById('loadBtn').disabled = true;

                try {
                    // Handle Author Feed and Author Likes modes
                    if (this.currentMode === 'author_feed') {
                        await this.loadAuthorFeedMode(handles[0]);
                        return;
                    } else if (this.currentMode === 'author_likes') {
                        await this.loadAuthorLikesMode(handles[0]);
                        return;
                    }

                    // Following Feed mode (default)
                    this.updateStatus('🔍 Resolving handles...');

                    // Check if account requires authentication (use first account for check)
                    if (!this.authToken) {
                        this.updateStatus('🔍 Checking account requirements...');
                        
                        const profileResponse = await fetch(
                            `${API_BASE}/app.bsky.actor.getProfile?actor=${encodeURIComponent(handles[0])}`
                        );
                        
                        if (profileResponse.ok) {
                            const profile = await profileResponse.json();
                            
                            if (profile.labels && Array.isArray(profile.labels)) {
                                const hasNoUnauthLabel = profile.labels.some(label => label.val === '!no-unauthenticated');
                                if (hasNoUnauthLabel) {
                                    this.updateStatus('❌ First account requires authentication to view');
                                    this.showError('These accounts are private and require you to be logged in to view their followers and feed.');
                                    document.getElementById('loadBtn').disabled = false;
                                    return;
                                }
                            }
                        }
                    }

                    this.updateStatus(`👥 Fetching follows from ${handles.length} account(s)...`);
                    
                    // Fetch follows from all target accounts
                    const allFollows = [];
                    const limiter = this.createRateLimiter(3);
                    
                    for (const handle of handles) {
                        await limiter.wait();
                        
                        try {
                            const did = await this.resolveHandleToDid(handle);
                            if (did) {
                                await this.getAllFollows(did);
                                allFollows.push(...this.followedAccounts);
                                this.updateStatus(`👥 Fetched follows from ${allFollows.length} unique accounts so far...`);
                            }
                        } catch (error) {
                            console.warn(`Error fetching follows for ${handle}:`, error);
                        }
                    }

                    // Deduplicate follows
                    this.followedAccounts = this.deduplicateFollows(allFollows);

                    if (this.followedAccounts.length === 0) {
                        this.updateStatus('❌ No followed accounts found');
                        return;
                    }

                    this.updateStatus(`⏳ Loading feeds from ${this.followedAccounts.length} unique accounts (this may take a moment)...`);
                    await this.loadInitialFeedsProgressively();

                    this.updateStatus('✅ Feed loaded! Scroll to load more.');
                    this.renderPage();
                    
                    // Auto-load mute and block lists if authenticated and enabled
                    if (this.authToken && this.muteBlockEnabled && !this.muteBlockListLoaded) {
                        await this.loadMuteAndBlockLists();
                    }
                } catch (error) {
                    console.error('Error loading feed:', error);
                    this.updateStatus(`❌ Error: ${error.message}`);
                    this.showError(`Failed to load feed: ${error.message}`);
                } finally {
                    document.getElementById('loadBtn').disabled = false;
                }
            }

            async loadAuthorFeedMode(handle) {
                try {
                    this.updateStatus('Loading author feed...');

                    // Resolve handle to DID if needed
                    let did = handle;
                    if (!handle.startsWith('did:')) {
                        did = await this.resolveHandleToDid(handle);
                        if (!did) {
                            throw new Error('Handle not found');
                        }
                    }

                    // Discover PDS for direct fetching
                    const pdsBase = await this.discoverPds(did);

                    // Reset feed state
                    this.resetFeedState();

                    // Get date range from UI
                    const { startDate, endDate } = this.getDateRangeFromUI();

                    // Fetch ALL author feed posts in date range (with pagination)
                    const feedResult = await this.getAuthorFeedWithDateRange(did, endDate, startDate, 'posts_with_replies', pdsBase);
                    if (!feedResult) {
                        throw new Error('Failed to load author feed');
                    }
                    
                    // Populate allPosts with feed items
                    this.allPosts = feedResult.feed || [];
                    this.followedAccounts = [{did: did, handle: handle}];

                    // In multi-account mode, load viewer data for secondary accounts
                    if (this.activeAccounts.length >= 2) {
                        this.updateStatus(`🔄 Loading interaction state for all accounts...`);
                        await this.loadDebugFeedsForViewerData(did);
                        this.updateStatus(`Loaded ${this.allPosts.length} posts from author (viewable by ${this.activeAccounts.length} accounts)`);
                    } else {
                        this.updateStatus(`Loaded ${this.allPosts.length} posts from author`);
                    }

                    // Persist viewer state so it survives page refreshes within the feed cache window
                    for (const slot of this.activeAccounts) {
                        await this.saveInteractionState(slot);
                    }

                    this.renderPage();
                } catch (error) {
                    this.updateStatus(`Error loading author feed: ${error.message}`);
                    this.showError(`Failed to load author feed: ${error.message}`);
                } finally {
                    document.getElementById('loadBtn').disabled = false;
                }
            }

            async loadAuthorLikesMode(handle) {
                try {
                    this.updateStatus('Loading author likes...');

                    // Resolve handle to DID if needed
                    let did = handle;
                    if (!handle.startsWith('did:')) {
                        did = await this.resolveHandleToDid(handle);
                        if (!did) {
                            throw new Error('Handle not found');
                        }
                    }

                    // Check privacy: if unauthenticated, ensure target account is public
                    if (!this.authToken) {
                        this.updateStatus('🔍 Checking account requirements...');
                        const profileResponse = await fetch(
                            `${API_BASE}/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
                        );
                        if (profileResponse.ok) {
                            const profile = await profileResponse.json();
                            if (this.hasNoUnauthenticatedLabel(profile)) {
                                this.updateStatus('❌ This account requires authentication to view');
                                this.showError('This account is private. Please log in to view their likes.');
                                document.getElementById('loadBtn').disabled = false;
                                return;
                            }
                        }
                    }

                    // Discover PDS for direct fetching
                    const pdsBase = await this.discoverPds(did);

                    // Reset feed state
                    this.resetFeedState();
                    this.isLikesMode = true;
                    this.likesTargetDid = did;
                    this.postCache = new Map();

                    // Fetch author likes using the likes filter
                    const result = await this.getAuthorFeed(did, null, true, 'likes', pdsBase);
                    if (!result) {
                        throw new Error('Failed to load author likes');
                    }
                    
                    // Store post URIs for lazy loading
                    if (result.postUris) {
                        this.postUrisToLoad = result.postUris;
                        // Create placeholder feed items, attaching the liked date for date filtering
                        this.allPosts = this.postUrisToLoad.map((uri, idx) => ({
                            uri: uri,
                            placeholder: true,
                            index: idx,
                            likedAt: this.likedAtMap.get(uri) || null
                        }));
                        this.updateStatus(`Loaded ${this.postUrisToLoad.length} likes. Fetching posts as you scroll...`);
                    } else {
                        this.allPosts = result.feed || [];
                    }
                    
                    this.followedAccounts = [{did: did, handle: handle}];

                    // Persist viewer state so it survives page refreshes within the feed cache window
                    for (const slot of this.activeAccounts) {
                        await this.saveInteractionState(slot);
                    }

                    this.renderPage();
                } catch (error) {
                    this.updateStatus(`Error loading author likes: ${error.message}`);
                    this.showError(`Failed to load author likes: ${error.message}`);
                } finally {
                    document.getElementById('loadBtn').disabled = false;
                }
            }

            async resolveHandleToDid(handle) {
                // Check cache first
                const cached = await this.cache.get(`handle:${handle}`);
                if (cached) return cached;

                try {
                    const response = await fetch(
                        `${API_BASE}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
                    );

                    if (!response.ok) {
                        throw new Error(`Handle not found: ${handle}`);
                    }

                    const data = await response.json();
                    const did = data.did;

                    // Cache for 4 hours
                    await this.cache.set(`handle:${handle}`, did, 4 * 3600 * 1000);
                    return did;
                } catch (error) {
                    throw new Error(`Failed to resolve handle: ${error.message}`);
                }
            }

            async discoverPds(handleOrDid) {
                // Auto-discover the PDS for a handle or DID via DID document resolution.
                // Falls back to https://bsky.social on any error.
                try {
                    let did = handleOrDid;
                    if (!handleOrDid.startsWith('did:')) {
                        did = await this.resolveHandleToDid(handleOrDid);
                        if (!did) return 'https://bsky.social';
                    }

                    // Check in-memory cache first
                    if (this.pdsCache.has(did)) return this.pdsCache.get(did);

                    // Fetch DID document
                    let didDoc;
                    if (did.startsWith('did:plc:')) {
                        const response = await fetch(`https://plc.directory/${encodeURIComponent(did)}`);
                        if (!response.ok) return 'https://bsky.social';
                        didDoc = await response.json();
                    } else if (did.startsWith('did:web:')) {
                        const domain = did.slice('did:web:'.length);
                        const response = await fetch(`https://${domain}/.well-known/did.json`);
                        if (!response.ok) return 'https://bsky.social';
                        didDoc = await response.json();
                    } else {
                        return 'https://bsky.social';
                    }

                    // Find the ATProto PDS service entry
                    const services = didDoc.service || [];
                    const pdsService = services.find(s => s.id === '#atproto_pds');
                    if (!pdsService || !pdsService.serviceEndpoint) return 'https://bsky.social';

                    const endpoint = pdsService.serviceEndpoint.replace(/\/$/, '');
                    this.pdsCache.set(did, endpoint);
                    return endpoint;
                } catch (error) {
                    console.warn(`PDS discovery failed for ${handleOrDid}:`, error);
                    return 'https://bsky.social';
                }
            }

            getBlobUrl(did, cid) {
                // Get blob URL using discovered PDS if cached, otherwise fall back to bsky.social
                const pds = this.pdsCache.has(did) ? this.pdsCache.get(did) : 'https://bsky.social';
                return `${pds}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${cid}`;
            }

            resolvePendingImageSources(root) {
                // <img> tags built from a raw (unhydrated) image blob ref whose author's PDS
                // wasn't cached yet at render time get their src patched in once it resolves.
                root.querySelectorAll('img[data-author-did][data-image-cid]').forEach(img => {
                    if (img.getAttribute('src')) return;

                    const did = img.dataset.authorDid;
                    const cid = img.dataset.imageCid;
                    this.discoverPds(did).then(() => {
                        img.src = this.getBlobUrl(did, cid);
                        if (this.imagePreloadingEnabled && img.matches(':hover')) {
                            this.preloadImage(img.src);
                        }
                    });
                });
            }

            async getAllFollows(actor) {
                const cached = await this.cache.get(`follows:${actor}`);
                if (cached) {
                    this.followedAccounts = cached;
                    return;
                }

                let cursor;
                const follows = [];
                const limiter = this.createRateLimiter(5);

                do {
                    await limiter.wait();

                    const params = new URLSearchParams({
                        actor,
                        limit: 100,
                        ...(cursor && { cursor })
                    });

                    // Always use default public AppView for follows
                    try {
                        const response = await this.bskyFetch(
                            `${API_BASE}/app.bsky.graph.getFollows?${params}`
                        );

                        if (!response.ok) {
                            throw new Error(`HTTP ${response.status}`);
                        }

                        const data = await response.json();
                        follows.push(...(data.follows || []));
                        cursor = data.cursor;

                        this.updateStatus(`👥 Fetched ${follows.length} followed accounts...`);
                    } catch (error) {
                        console.error(`Error fetching follows page:`, error);
                        break;
                    }
                } while (cursor);

                this.followedAccounts = follows;

                // Cache for 4 hours
                await this.cache.set(`follows:${actor}`, follows, 4 * 3600 * 1000);
            }

            async loadInitialFeedsProgressively() {
                const limiter = this.createRateLimiter(5);
                const batchSize = 20;

                const { startDate, endDate } = this.getDateRangeFromUI();
                const filterSelect = document.getElementById('filterSelect').value;

                // Accounts whose feed request failed outright (not just "no posts") get retried later
                const failedAccounts = [];

                // Load feeds in batches of 5 with delay between batches
                for (let i = 0; i < this.followedAccounts.length; i += batchSize) {
                    const batch = this.followedAccounts.slice(i, i + batchSize);
                    const feedPromises = batch.map(account =>
                        limiter.wait().then(() => {
                            // Check if profile should be skipped due to authentication requirements
                            if (!this.authToken && this.hasNoUnauthenticatedLabel(account)) {
                                return null;
                            }
                            const actor = account.handle === 'handle.invalid' ? account.did : account.handle;
                            return this.getAuthorFeedWithDateRange(actor, endDate, startDate, filterSelect);
                        })
                    );

                    const results = await Promise.allSettled(feedPromises);

                    results.forEach((result, index) => {
                        if (result.status === 'fulfilled' && result.value) {
                            const { feed, cursor, failed } = result.value;
                            if (feed && feed.length > 0) {
                                this.allPosts.push(...feed);
                                const storeKey = batch[index].handle === 'handle.invalid' ? batch[index].did : batch[index].handle;
                                this.feedCursors.set(storeKey, cursor);
                            }
                            if (failed) {
                                failedAccounts.push(batch[index]);
                            }
                        } else if (result.status === 'rejected') {
                            failedAccounts.push(batch[index]);
                        }
                    });

                    this.updateFeedStats();
                    this.updateStatus(`⏳ Loaded ${Math.min(i + batchSize, this.followedAccounts.length)}/${this.followedAccounts.length} accounts...`);

                    // Small delay between batches to avoid rate limiting
                    if (i + batchSize < this.followedAccounts.length) {
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                }

                // Retry accounts whose feed request failed before giving up on them
                if (failedAccounts.length > 0) {
                    await this.retryFailedAccountFeeds(failedAccounts, endDate, startDate, filterSelect);
                }

                // Sort once after all batches (and retries) are loaded
                if (this.sortOrder === 'descending') {
                    this.allPosts.sort((a, b) => this.getPostDate(b) - this.getPostDate(a));
                } else {
                    this.allPosts.sort((a, b) => this.getPostDate(a) - this.getPostDate(b));
                }

                // In multi-account mode, reload feeds with each account's token to get their viewer data
                if (this.activeAccounts.length >= 2) {
                    this.updateStatus('🔄 Loading interaction state for all accounts...');
                    await this.loadFeedsForViewerData();
                }

                // Persist the viewer state so it survives page refreshes within the feed cache window
                for (const slot of this.activeAccounts) {
                    await this.saveInteractionState(slot);
                }
            }

            async retryFailedAccountFeeds(accounts, endDate, startDate, filterSelect, maxRounds = 2) {
                // Re-attempt feed fetches for accounts that failed during the initial pass,
                // with a backoff between rounds so transient outages have time to clear.
                let pending = accounts;

                for (let round = 1; round <= maxRounds && pending.length > 0; round++) {
                    this.updateStatus(`🔁 Retrying ${pending.length} failed feed${pending.length > 1 ? 's' : ''} (attempt ${round}/${maxRounds})...`);
                    await new Promise(resolve => setTimeout(resolve, 2000 * round));

                    const stillFailing = [];
                    for (const account of pending) {
                        const actor = account.handle === 'handle.invalid' ? account.did : account.handle;
                        let result;
                        try {
                            result = await this.getAuthorFeedWithDateRange(actor, endDate, startDate, filterSelect);
                        } catch (error) {
                            result = null;
                        }

                        if (result && result.feed && result.feed.length > 0) {
                            this.allPosts.push(...result.feed);
                            const storeKey = account.handle === 'handle.invalid' ? account.did : account.handle;
                            this.feedCursors.set(storeKey, result.cursor);
                        }
                        if (!result || result.failed) {
                            stillFailing.push(account);
                        }
                    }
                    pending = stillFailing;
                    this.updateFeedStats();
                }

                if (pending.length > 0) {
                    const names = pending.map(a => a.handle).join(', ');
                    console.warn(`Giving up on ${pending.length} account feed(s) after retries: ${names}`);
                    this.updateStatus(`⚠️ Could not load feed for ${pending.length} account(s) after retries.`);
                }
            }

            async loadFeedsForViewerData() {
                // Fetch feeds with secondary accounts' tokens to capture their viewer data
                // Skip primary account (activeAccounts[0]) since Phase 1 already loaded it
                // Use higher concurrency since we're only fetching for 1-2 secondary accounts
                const limiter = this.createRateLimiter(8); // Higher rate limit for Phase 2
                const { startDate, endDate } = this.getDateRangeFromUI();
                const filterSelect = document.getElementById('filterSelect').value;

                for (let idx = 1; idx < this.activeAccounts.length; idx++) {
                    const slot = this.activeAccounts[idx];
                    const account = this.accounts[slot];
                    if (!account) continue;

                    // For secondary accounts, fetch all accounts in larger batches with higher concurrency
                    for (let i = 0; i < this.followedAccounts.length; i += 20) {
                        const batch = this.followedAccounts.slice(i, i + 20);
                        const feedPromises = batch.map(followedAccount =>
                            limiter.wait().then(() => {
                                const actor = followedAccount.handle === 'handle.invalid' ? followedAccount.did : followedAccount.handle;
                                return this.getAuthorFeedWithDateRangeForAccount(actor, endDate, startDate, filterSelect, slot);
                            })
                        );

                        await Promise.allSettled(feedPromises);

                        // Smaller delay between batches in Phase 2
                        if (i + 20 < this.followedAccounts.length) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                    }

                    this.updateStatus(`✅ Loaded interaction state for account ${slot}`);
                }

                this.updateStatus('✅ Feed ready! Both accounts can interact.');
            }

            async getAuthorFeedWithDateRangeForAccount(actor, endDate, startDate, filter, accountSlot) {
                let allFeed = [];
                let cursor = endDate || undefined;
                let isFirstRequest = true;
                let failed = false;

                while (cursor) {
                    const result = await this.getAuthorFeedForAccount(actor, cursor, isFirstRequest, filter, accountSlot);
                    isFirstRequest = false;

                    if (!result) {
                        // Request ultimately failed (after bskyFetch's own retries) — let the
                        // caller know so it can queue this account for a later retry.
                        failed = true;
                        break;
                    }
                    if (!result.feed || result.feed.length === 0) {
                        break;
                    }

                    allFeed.push(...result.feed);
                    cursor = result.cursor;

                    if (startDate && cursor && cursor < startDate) {
                        break;
                    }

                    await new Promise(resolve => setTimeout(resolve, 100));
                }

                return {
                    feed: allFeed,
                    cursor: cursor,
                    failed
                };
            }

            async getAuthorFeedForAccount(actor, cursor, isInitial = true, filter = 'posts_with_replies', accountSlot = null) {
                try {
                    const limit = isInitial ? 50 : 100;
                    
                    // Get token for specific account
                    const account = accountSlot ? this.accounts[accountSlot] : null;
                    const token = account ? account.token : this.authToken;
                    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

                    // Use specialized method for likes
                    if (filter === 'likes') {
                        return await this.getAuthorLikesForAccount(actor, cursor, isInitial, accountSlot);
                    }

                    const params = new URLSearchParams({
                        actor,
                        limit: limit,
                        filter: filter,
                        ...(cursor && { cursor })
                    });

                    const endpoint = `https://bsky.social/xrpc/app.bsky.feed.getAuthorFeed?${params}`;
                    const response = await this.bskyFetch(endpoint, { headers });

                    if (!response.ok) {
                        console.warn(`Failed to fetch feed for ${actor} (${accountSlot}): HTTP ${response.status}`);
                        return null;
                    }

                    const data = await response.json();
                    const result = {
                        feed: data.feed || [],
                        cursor: data.cursor
                    };

                    // Extract viewer data to correct maps
                    if (accountSlot && data.feed) {
                        const { liked, reposted } = this.extractViewerData(data.feed, accountSlot);
                        if (this.DEBUG) console.log(`[Phase 2] Extracted: ${liked} likes, ${reposted} reposts for account ${accountSlot}`);
                    }

                    return result;
                } catch (error) {
                    console.warn(`Error fetching feed for ${actor} (${accountSlot}):`, error);
                    return null;
                }
            }

            async getAuthorLikesForAccount(actor, cursor, isInitial = true, accountSlot = null) {
                if (this.isActorLoggedIn(actor)) {
                    return await this.getAuthorLikesViaAPI(actor, cursor, isInitial, null, accountSlot);
                }
                return await this.getAuthorLikesViaRepo(actor, cursor, isInitial, null, accountSlot);
            }

            async getAuthorLikes(actor, cursor, isInitial = true, pdsBase = null) {
                if (this.isActorLoggedIn(actor)) {
                    return await this.getAuthorLikesViaAPI(actor, cursor, isInitial, pdsBase, null);
                }
                return await this.getAuthorLikesViaRepo(actor, cursor, isInitial, pdsBase, null);
            }

            isActorLoggedIn(actor) {
                return this.getSlotForActor(actor) !== null;
            }

            getSlotForActor(actor) {
                if (!actor) return null;
                if (!actor.startsWith('did:')) {
                    for (const slot of Object.keys(this.accounts)) {
                        if (this.accounts[slot].handle === actor) return slot;
                    }
                } else {
                    for (const slot of Object.keys(this.accounts)) {
                        if (this.accounts[slot].did === actor) return slot;
                    }
                }
                return null;
            }

            getMapsForSlot(slot) {
                return {
                    likedMap: slot === 'A' ? this.likedPosts_A : slot === 'B' ? this.likedPosts_B : this.likedPosts,
                    repostedMap: slot === 'A' ? this.repostedPosts_A : slot === 'B' ? this.repostedPosts_B : this.repostedPosts,
                    bookmarkedSet: slot === 'A' ? this.bookmarkedPosts_A : slot === 'B' ? this.bookmarkedPosts_B : this.bookmarkedPosts
                };
            }

            async getAuthorLikesViaAPI(actor, cursor, isInitial = true, pdsBase = null, accountSlot = null) {
                // Load all liked post URIs via the getActorLikes API.
                // accountSlot: fallback token when the actor is not a logged-in account.
                try {
                    const allPostUris = [];
                    const { startDate, endDate } = this.getDateRangeFromUI();
                    let currentCursor = endDate ? this.dateToTid(endDate) : undefined;
                    const limiter = this.createRateLimiter(3);

                    // getActorLikes requires the token of the target actor
                    const actorSlot = this.getSlotForActor(actor);
                    const token = actorSlot ? this.accounts[actorSlot]?.token
                        : (accountSlot ? this.accounts[accountSlot]?.token : this.authToken);
                    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
                    const endpointBase = pdsBase ? `${pdsBase}/xrpc` : 'https://bsky.social/xrpc';

                    while (true) {
                        await limiter.wait();

                        const params = new URLSearchParams({
                            actor,
                            limit: 100,
                            ...(currentCursor && { cursor: currentCursor })
                        });

                        const response = await this.bskyFetch(`${endpointBase}/app.bsky.feed.getActorLikes?${params}`, { headers });
                        if (!response.ok) {
                            console.warn(`Failed to fetch likes via API for ${actor}: HTTP ${response.status}`);
                            break;
                        }

                        const data = await response.json();
                        if (!data.feed || data.feed.length === 0) break;

                        // Collect URIs; decode liked date from viewer.like TID rkey; stop when before startDate.
                        let reachedStart = false;
                        const { likedMap, repostedMap } = this.getMapsForSlot(actorSlot);
                        for (const item of data.feed) {
                            if (!item.post?.uri) continue;
                            const likedAt = item.post.viewer?.like
                                ? this.decodeTidToDate(item.post.viewer.like.split('/').pop())
                                : null;
                            if (startDate && likedAt && likedAt < startDate) { reachedStart = true; break; }
                            allPostUris.push(item.post.uri);
                            if (item.post.viewer) {
                                if (item.post.viewer.like) {
                                    likedMap.set(item.post.uri, item.post.viewer.like);
                                    if (likedAt) this.likedAtMap.set(item.post.uri, likedAt);
                                }
                                if (item.post.viewer.repost) repostedMap.set(item.post.uri, item.post.viewer.repost);
                            }
                        }
                        if (reachedStart) break;

                        currentCursor = data.cursor;
                        if (!currentCursor) break;
                    }

                    this.updateStatus(`Loaded ${allPostUris.length} likes. Fetching posts as you scroll...`);
                    return { postUris: allPostUris, isLikesMode: true };
                } catch (error) {
                    console.warn(`Error fetching likes via API for ${actor}:`, error);
                    return null;
                }
            }

            async getAuthorLikesViaRepo(actor, cursor, isInitial = true, pdsBase = null, accountSlot = null) {
                // Load all liked post URIs via com.atproto.repo.listRecords.
                // accountSlot: use that account's token when provided.
                try {
                    const allPostUris = [];
                    const { startDate, endDate } = this.getDateRangeFromUI();
                    let currentCursor = endDate ? this.dateToTid(endDate) : undefined;
                    const limiter = this.createRateLimiter(3);

                    let did = actor;
                    if (!actor.startsWith('did:')) {
                        did = await this.resolveHandleToDid(actor);
                        if (!did) throw new Error('Could not resolve handle to DID');
                    }

                    const token = accountSlot ? this.accounts[accountSlot]?.token : this.authToken;
                    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
                    const initialBase = pdsBase || 'https://bsky.social';

                    while (true) {
                        await limiter.wait();

                        const params = new URLSearchParams({
                            repo: did,
                            collection: 'app.bsky.feed.like',
                            limit: 100,
                            ...(currentCursor && { cursor: currentCursor })
                        });

                        const response = await this.bskyFetchForActor(
                            did,
                            base => `${base}/xrpc/com.atproto.repo.listRecords?${params}`,
                            { headers },
                            initialBase
                        );
                        if (!response.ok) {
                            console.warn(`Failed to fetch likes via repo for ${actor}: HTTP ${response.status}`);
                            break;
                        }

                        const data = await response.json();

                        // Collect URIs and liked dates; stop when before startDate.
                        let reachedStart = false;
                        for (const record of (data.records || [])) {
                            const uri = record.value?.subject?.uri;
                            if (!uri) continue;
                            const likedAt = record.value?.createdAt;
                            if (startDate && likedAt && likedAt < startDate) { reachedStart = true; break; }
                            allPostUris.push(uri);
                            if (likedAt) this.likedAtMap.set(uri, likedAt);
                        }
                        if (reachedStart) break;

                        currentCursor = data.cursor;
                        if (!currentCursor) break;
                    }

                    this.updateStatus(`Loaded ${allPostUris.length} likes. Fetching posts as you scroll...`);
                    return { postUris: allPostUris, isLikesMode: true };
                } catch (error) {
                    console.warn(`Error fetching likes via repo for ${actor}:`, error);
                    return null;
                }
            }

            async getAuthorFeed(actor, cursor, isInitial = true, filter = 'posts_with_replies', pdsBase = null) {
                // Use specialized method for likes
                if (filter === 'likes') {
                    return await this.getAuthorLikes(actor, cursor, isInitial, pdsBase);
                }

                const cacheKey = this.getFeedCacheKey(actor, cursor, filter);
                const cached = await this.cache.get(cacheKey);
                if (cached) return cached;

                try {
                    const limit = isInitial ? 50 : 100;
                    const params = new URLSearchParams({
                        actor,
                        limit: limit,
                        filter: filter,
                        ...(cursor && { cursor })
                    });

                    // Use authenticated endpoint if logged in
                    const endpoint = this.authToken
                        ? `https://bsky.social/xrpc/app.bsky.feed.getAuthorFeed?${params}`
                        : `${API_BASE}/app.bsky.feed.getAuthorFeed?${params}`;

                    const headers = this.authToken
                        ? { 'Authorization': `Bearer ${this.authToken}` }
                        : {};

                    const response = await this.bskyFetch(endpoint, { headers });

                    if (!response.ok) {
                        console.warn(`Failed to fetch feed for ${actor}: HTTP ${response.status}`);
                        return null;
                    }

                    const data = await response.json();
                    const result = {
                        feed: data.feed || [],
                        cursor: data.cursor
                    };

                    // Extract viewer data for primary account (Phase 1 uses this method)
                    // Also handles legacy single-account where activeAccounts may be empty
                    if (data.feed && (this.activeAccounts.length > 0 || this.authToken)) {
                        const primarySlot = this.activeAccounts.length > 0 ? this.activeAccounts[0] : null;
                        const { likedMap: targetMap_liked, repostedMap: targetMap_reposted, bookmarkedSet: targetSet_bookmarked } = this.getMapsForSlot(primarySlot);
                        let likedCount = 0, repostedCount = 0;
                        data.feed.forEach(item => {
                            const post = item.post;
                            if (post.viewer) {
                                if (post.viewer.like) {
                                    targetMap_liked.set(post.uri, post.viewer.like);
                                    likedCount++;
                                }
                                if (post.viewer.repost) {
                                    targetMap_reposted.set(post.uri, post.viewer.repost);
                                    repostedCount++;
                                }
                                if (post.viewer.bookmarked) {
                                    targetSet_bookmarked.add(post.uri);
                                }
                            }
                            // Also capture viewer data from reply parent
                            if (item.reply && item.reply.parent && item.reply.parent.viewer) {
                                const parent = item.reply.parent;
                                if (parent.viewer.like) {
                                    targetMap_liked.set(parent.uri, parent.viewer.like);
                                    likedCount++;
                                }
                                if (parent.viewer.repost) {
                                    targetMap_reposted.set(parent.uri, parent.viewer.repost);
                                    repostedCount++;
                                }
                                if (parent.viewer.bookmarked) {
                                    targetSet_bookmarked.add(parent.uri);
                                }
                            }
                        });
                        if (this.DEBUG) console.log(`[Phase 1] Extracted: ${likedCount} likes, ${repostedCount} reposts for account ${primarySlot}`);
                    }

                    // Cache for 15 minutes
                    await this.cache.set(cacheKey, result, 15 * 60 * 1000);
                    return result;
                } catch (error) {
                    console.warn(`Error fetching feed for ${actor}:`, error);
                    return null;
                }
            }

            async getAuthorFeedWithDateRange(actor, endDate, startDate, filter, pdsBase = null) {
                let allFeed = [];
                let cursor = endDate || undefined;
                let isFirstRequest = true;
                let failed = false;

                while (cursor) {
                    const result = await this.getAuthorFeed(actor, cursor, isFirstRequest, filter, pdsBase);
                    isFirstRequest = false;

                    if (!result) {
                        // Request ultimately failed (after bskyFetch's own retries) — let the
                        // caller know so it can queue this account for a later retry.
                        failed = true;
                        break;
                    }
                    if (!result.feed || result.feed.length === 0) {
                        break;
                    }

                    allFeed.push(...result.feed);
                    cursor = result.cursor;

                    // Stop if cursor is before startDate
                    if (startDate && cursor && cursor < startDate) {
                        break;
                    }

                    // Add small delay between paginated requests to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 100));
                }

                return {
                    feed: allFeed,
                    cursor: cursor,
                    failed
                };
            }

            async loadNextPage() {
                if (this.isLoading) return;
                this.isLoading = true;

                try {
                    // Only render more posts from already-loaded data, don't fetch new data
                    const startDateInput = document.getElementById('startDateInput').value;
                    const startDate = startDateInput ? new Date(startDateInput).toISOString() : null;

                    // Filter posts to only show those after startDate
                    let filteredPosts = this.allPosts;
                    if (startDate) {
                        filteredPosts = this.allPosts.filter(item =>
                            this.getPostDate(item).toISOString() >= startDate
                        );
                    }

                    // Render if we have more posts to display
                    if (filteredPosts.length > this.displayedCount) {
                        this.showBatchLoadingIndicator();
                        // Two rAF passes: first schedules the paint, second runs after it completes
                        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                        const pendingFetches = this.renderPage();
                        // If there are HTTP requests in-flight (likes mode), wait for them all
                        if (pendingFetches && pendingFetches.length > 0) {
                            await Promise.allSettled(pendingFetches);
                        }
                        this.hideBatchLoadingIndicator();
                        // Resolve the batch divider: transition to done then fade out
                        if (this._lastBatchDivider) {
                            const divider = this._lastBatchDivider;
                            this._lastBatchDivider = null;
                            divider.classList.remove('batch-divider--loading');
                            divider.classList.add('batch-divider--done');
                            setTimeout(() => {
                                divider.style.opacity = '0';
                                setTimeout(() => divider.remove(), 500);
                            }, 600);
                        }
                    }
                } finally {
                    this.isLoading = false;
                }
            }

            showBatchLoadingIndicator() {
                const el = document.getElementById('batch-loading-indicator');
                if (el) el.style.display = 'flex';
            }

            hideBatchLoadingIndicator() {
                const el = document.getElementById('batch-loading-indicator');
                if (el) el.style.display = 'none';
            }

            // options.items: render exactly these items instead of slicing from displayedCount
            //   (used by restoreOldPosts() to re-insert a previously-unloaded chunk).
            // options.insertBefore: insert before this node instead of appending to the feed end.
            // options.updateState: when false, skip displayedCount/stats updates and unloading
            //   (the caller is restoring already-counted posts, not loading new ones).
            renderPage(options = {}) {
                const feed = document.getElementById('feed');

                // Get startDate from input
                const startDateInput = document.getElementById('startDateInput').value;
                const startDate = startDateInput ? new Date(startDateInput).toISOString() : null;

                let newPosts;
                if (options.items) {
                    newPosts = options.items;
                } else {
                const filterKey = this.getFilterCacheKey();

                // Only filter if params changed
                if (this.lastFilterParams !== filterKey) {
                    this.filteredPostsCache = this.allPosts.filter(item => {
                        // Skip ALL filtering for debug posts
                        if (item.isDebugPost) {
                            return true;
                        }
                        
                        // Skip placeholder items in likes mode
                        if (item.placeholder) {
                            return true;
                        }
                        
                        // Skip items without post data
                        if (!item.post) {
                            return false;
                        }
                        
                        // Date filter
                        if (startDate && this.getPostDate(item).toISOString() < startDate) {
                            return false;
                        }
                        // Mute/Block filter (if enabled)
                        if (this.muteBlockEnabled && this.muteBlockListLoaded) {
                            const authorDid = item.post.author.did;
                            // Exclude posts from muted/blocked authors
                            if (this.mutedAccounts.has(authorDid) || this.blockedAccounts.has(authorDid)) {
                                return false;
                            }
                            // Exclude reposts from muted/blocked accounts
                            if (item.reason && item.reason.$type === 'app.bsky.feed.defs#reasonRepost') {
                                if (this.mutedAccounts.has(item.reason.by.did) || this.blockedAccounts.has(item.reason.by.did)) {
                                    return false;
                                }
                            }
                        }
                        return true;
                    });
                    this.lastFilterParams = filterKey;

                    // Deduplication: show each post URI at most once (debug/placeholder posts are always kept)
                    if (this.deduplicatePosts) {
                        const seenUris = new Set();
                        this.filteredPostsCache = this.filteredPostsCache.filter(item => {
                            if (item.isDebugPost || item.placeholder || !item.post) return true;
                            if (seenUris.has(item.post.uri)) return false;
                            seenUris.add(item.post.uri);
                            return true;
                        });
                    }
                }

                let filteredPosts = this.filteredPostsCache;

                // Sort based on selected order
                if (this.sortOrder === 'descending') {
                    filteredPosts = filteredPosts.sort((a, b) =>
                        this.getPostDate(b) - this.getPostDate(a)
                    );
                } else {
                    filteredPosts = filteredPosts.sort((a, b) =>
                        this.getPostDate(a) - this.getPostDate(b)
                    );
                }

                newPosts = filteredPosts.slice(this.displayedCount, this.displayedCount + this.postsPerPage);
                }

                // Collect async fetch promises for likes mode so caller can await them
                const pendingFetches = [];

                // Use document fragment for batch DOM inserts
                const fragment = document.createDocumentFragment();

                // Prepend a batch-loading divider before the first post of every batch after the first
                if (!options.items && this.displayedCount > 0) {
                    const divider = document.createElement('div');
                    divider.className = 'batch-divider batch-divider--loading';
                    divider.innerHTML = '<span class="batch-divider-spinner"></span><span class="batch-divider-label">Loading next batch…</span>';
                    fragment.appendChild(divider);
                    this._lastBatchDivider = divider;
                }

                newPosts.forEach(item => {
                    // Handle lazy-loaded posts in likes mode
                    if (item.placeholder && item.uri && this.isLikesMode) {
                        // Create loading placeholder while fetching
                        const placeholderEl = document.createElement('div');
                        placeholderEl.className = 'post';
                        placeholderEl.setAttribute('data-post-uri', item.uri);
                        placeholderEl.innerHTML = '<div style="padding: 16px; color: #888;">Loading post...</div>';
                        fragment.appendChild(placeholderEl);
                        
                        // Fetch post asynchronously and track the promise
                        const fetchPromise = this.fetchPostByUri(item.uri).then(post => {
                            const toReplace = document.querySelector(`[data-post-uri="${CSS.escape(item.uri)}"]`);
                            if (post) {
                                // Replace placeholder with actual post
                                if (toReplace) {
                                    const newEl = this.createPostElementFromData(post, item);
                                    toReplace.replaceWith(newEl);
                                    this.resolvePendingImageSources(newEl);
                                }
                            } else if (toReplace) {
                                // Failed even after internal retries — offer a manual retry
                                toReplace.innerHTML = `<div style="padding: 16px; color: #e0245e; display: flex; align-items: center; gap: 10px;">
                                    ⚠️ Failed to load post.
                                    <button onclick="app.retryPostPlaceholder('${item.uri.replace(/'/g, "\\'")}')" style="padding: 4px 10px; cursor: pointer;">Retry</button>
                                </div>`;
                            }
                        }).catch(err => console.warn('Failed to fetch post:', err));
                        pendingFetches.push(fetchPromise);
                        return;
                    }

                    // Regular post rendering
                    if (!item.post) {
                        console.warn('Item without post data encountered, skipping:', item);
                        return;
                    }
                    
                    const post = item.post;
                    const author = post.author;
                    const record = post.record;

                    const postEl = document.createElement('div');
                    // Add reply class if this is a reply
                    postEl.className = (record.reply && record.reply.parent) ? 'post post-is-reply' : 'post';
                    postEl.setAttribute('data-post-uri', post.uri);

                    const postDate = new Date(record.createdAt);
                    const timeAgo = this.formatTimeAgo(postDate);
                    const fullDate = postDate.toLocaleString();
                    const avatarHtml = this.getAvatarHtml(author);

                    // Extract images from post embed (handle both direct images and recordWithMedia)
                    let imagesHtml = '';
                    let imagesToProcess = [];

                    if (record.embed && record.embed.$type === 'app.bsky.embed.recordWithMedia' && record.embed.media && record.embed.media.images) {
                        // recordWithMedia has images in media.images
                        imagesToProcess = record.embed.media.images;
                    } else if (record.embed && record.embed.images && record.embed.images.length > 0) {
                        // Direct image embed
                        imagesToProcess = record.embed.images;
                    } else if (post.embed && post.embed.$type === 'app.bsky.embed.external#view' && post.embed.external) {
                        // External link - use the actual URI if it's a media file, otherwise show as clickable link
                        const externalUri = post.embed.external.uri;
                        const externalThumb = post.embed.external.thumb;
                        const externalTitle = post.embed.external.title || '';
                        const externalDesc = post.embed.external.description || '';
                        
                        // Check if it's a direct media URL (GIF, WebP, etc)
                        if (externalUri && /\.(gif|webp|mp4|webm)(\?|$)/i.test(externalUri)) {
                            // Use the actual media URL
                            imagesToProcess = [{ thumb: externalUri, alt: externalDesc }];
                        } else {
                            // Show as clickable card with thumbnail linking to external URL
                            // Omit the <img> entirely when there's no thumbnail — src="" would
                            // resolve to the page's own URL and fire a spurious load error.
                            const thumbImgHtml = externalThumb ? `<img src="${externalThumb}" alt="${this.escapeHtml(externalDesc)}">` : '';
                            imagesHtml = `<div class="post-external-link" onclick="window.open('${externalUri.replace(/'/g, "\\'")}', '_blank')">
                                ${thumbImgHtml}
                                <div class="post-external-link-info">
                                    <div class="post-external-link-title">${this.escapeHtml(externalTitle)}</div>
                                    <div class="post-external-link-domain">${this.escapeHtml(externalUri.replace(/https?:\/\/(www\.)?/, '').split('/')[0])}</div>
                                </div>
                            </div>`;
                        }
                    }

                    if (imagesToProcess.length > 0) {
                        imagesHtml = `<div class="post-images">`;
                        // Collect all image URLs
                        const imageUrls = this.extractImageUrls(imagesToProcess, author.did);
                        // Create HTML with complete imageUrls array
                        imagesToProcess.forEach((img, index) => {
                            let imageUrl = imageUrls[index];
                            const alt = img.alt || 'Post image';
                            if (imageUrl) {
                                imagesHtml += `<img src="${imageUrl}" alt="${alt}" class="post-image" onclick="app.openImageModalFromEl(this)" />`;
                            } else if (img.image?.ref?.$link) {
                                // Author's PDS isn't known yet — resolved async, see resolvePendingImageSources
                                imagesHtml += `<img alt="${alt}" class="post-image" data-author-did="${author.did}" data-image-cid="${img.image.ref.$link}" onclick="app.openImageModalFromEl(this)" />`;
                            }
                        });
                        imagesHtml += '</div>';
                    }

                    // Extract video from post embed
                    let videoHtml = '';
                    if (record.embed && record.embed.$type === 'app.bsky.embed.video' && record.embed.video) {
                        const video = record.embed.video;

                        if (video.ref && video.ref.$link) {
                            const cid = video.ref.$link;
                            // The hydrated view (as opposed to the raw record) carries a CDN
                            // thumbnail — cheap to show up front, unlike the video itself.
                            const thumbUrl = post.embed && post.embed.$type === 'app.bsky.embed.video#view' ? post.embed.thumbnail : null;
                            const thumbStyle = thumbUrl ? ` style="background-image: url('${this.escapeHtml(thumbUrl)}'); background-size: cover; background-position: center;"` : '';
                            // Not fetched until the user clicks (see loadAndPlayVideo) — PDS
                            // discovery and the blob download both happen on demand instead of
                            // preloading every video in the feed up front.
                            videoHtml = `<div class="post-video" data-author-did="${author.did}" data-video-cid="${cid}"><div class="video-placeholder"${thumbStyle} onclick="app.loadAndPlayVideo(this)"><span class="video-play-btn">▶</span></div></div>`;
                        }
                    }

                    // Check for reply and build parent post card
                    let replyParentPostHtml = '';
                    let replyParentAuthor, replyParentText, replyParentUri, replyParentTime, replyParentFullDate, replyParentImages = [];
                    let replyParentVideoHtml = '';
                    let replyParentStats = { likes: 0, replies: 0, reposts: 0 };
                    let replyParentCid = '';

                    if (item.reply && item.reply.parent) {
                        const replyParent = item.reply.parent;
                        replyParentAuthor = replyParent.author;
                        replyParentText = replyParent.record ? this.breakLongWords(replyParent.record.text) : '';
                        replyParentUri = replyParent.uri;
                        replyParentCid = replyParent.cid || '';
                        if (replyParent.record) {
                            const parentDate = new Date(replyParent.record.createdAt);
                            replyParentTime = this.formatTimeAgo(parentDate);
                            replyParentFullDate = parentDate.toLocaleString();
                        }

                        // Extract stats from reply parent post
                        replyParentStats = {
                            likes: replyParent.likeCount || 0,
                            replies: replyParent.replyCount || 0,
                            reposts: replyParent.repostCount || 0
                        };

                        // Extract images from reply parent post
                        if (replyParent.embed && replyParent.embed.$type === 'app.bsky.embed.images#view' && replyParent.embed.images) {
                            replyParentImages = replyParent.embed.images;
                        } else if (replyParent.embed && replyParent.embed.$type === 'app.bsky.embed.recordWithMedia#view' && replyParent.embed.media && replyParent.embed.media.images) {
                            replyParentImages = replyParent.embed.media.images;
                        } else if (replyParent.embed && replyParent.embed.$type === 'app.bsky.embed.external#view' && replyParent.embed.external) {
                            // Handle GIF/WebP/media-only posts
                            const externalUri = replyParent.embed.external.uri;
                            const externalThumb = replyParent.embed.external.thumb;
                            if (externalUri && /\.(gif|webp|mp4|webm)(\?|$)/i.test(externalUri)) {
                                // Treat as image/media
                                replyParentImages = [{ thumb: externalUri, fullsize: externalUri, alt: replyParent.embed.external.description || 'Media' }];
                            }
                        }

                        const parentRecordEmbed = replyParent.record && replyParent.record.embed;
                        const parentVideo = parentRecordEmbed && parentRecordEmbed.$type === 'app.bsky.embed.video'
                            ? parentRecordEmbed.video
                            : parentRecordEmbed && parentRecordEmbed.$type === 'app.bsky.embed.recordWithMedia' && parentRecordEmbed.media
                                ? parentRecordEmbed.media.video
                                : null;
                        const parentVideoCid = parentVideo && parentVideo.ref && parentVideo.ref.$link;
                        if (parentVideoCid) {
                            const parentVideoView = replyParent.embed && replyParent.embed.$type === 'app.bsky.embed.video#view'
                                ? replyParent.embed
                                : replyParent.embed && replyParent.embed.$type === 'app.bsky.embed.recordWithMedia#view'
                                    ? replyParent.embed.media
                                    : null;
                            const parentThumbUrl = parentVideoView && parentVideoView.thumbnail;
                            const parentThumbStyle = parentThumbUrl ? ` style="background-image: url('${this.escapeHtml(parentThumbUrl)}'); background-size: cover; background-position: center;"` : '';
                            replyParentVideoHtml = `<div class="post-video" data-author-did="${replyParentAuthor.did}" data-video-cid="${parentVideoCid}"><div class="video-placeholder"${parentThumbStyle} onclick="app.loadAndPlayVideo(this)"><span class="video-play-btn">▶</span></div></div>`;
                        }
                    }

                    if (replyParentAuthor && replyParentUri && (replyParentText || replyParentImages.length > 0 || replyParentVideoHtml)) {
                        const parentDisplayName = replyParentAuthor.displayName || replyParentAuthor.handle;
                        const parentAvatarHtml = this.getAvatarHtml(replyParentAuthor);

                        // Build parent post images HTML
                        let parentImagesHtml = '';
                        if (replyParentImages.length > 0) {
                            parentImagesHtml = '<div class="post-parent-images">';
                            // Collect all image URLs
                            const replyImageUrls = this.extractImageUrls(replyParentImages, replyParentAuthor.did);
                            // Create HTML with complete replyImageUrls array
                            replyParentImages.forEach((img, index) => {
                                let imageUrl = replyImageUrls[index];
                                if (imageUrl) {
                                    const alt = img.alt || 'Parent post image';
                                    parentImagesHtml += `<img src="${imageUrl}" alt="${alt}" class="post-parent-image" onclick="app.openImageModal('${imageUrl.replace(/'/g, "\\'")}', ${JSON.stringify(replyImageUrls).replace(/"/g, '&quot;')})" />`;
                                }
                            });
                            parentImagesHtml += '</div>';
                        }

                        replyParentPostHtml = `
                                <div class="post-parent-container">
                                    <div class="post-parent-header">
                                        <div class="post-parent-avatar">${parentAvatarHtml}</div>
                                        <div class="post-parent-author-info">
                                            <div class="post-parent-author-name">
                                                <a href="https://bsky.app/profile/${replyParentAuthor.did}" class="post-author-link" target="_blank" rel="noopener noreferrer">
                                                    ${parentDisplayName}
                                                </a>
                                            </div>
                                            <div class="post-parent-author-handle">@${replyParentAuthor.handle} · <a href="https://bsky.app/profile/${replyParentAuthor.did}/post/${replyParentUri.split('/').pop()}" class="post-timestamp" title="${replyParentFullDate}" target="_blank" rel="noopener noreferrer">${replyParentTime}</a></div>
                                        </div>
                                    </div>
                                    <div class="post-parent-body">
                                        <a href="https://bsky.app/profile/${replyParentAuthor.did}/post/${replyParentUri.split('/').pop()}" class="post-parent-link-wrapper" target="_blank" rel="noopener noreferrer">
                                        <div class="post-parent-text">${replyParentText}</div>
                                          </a>
                                        ${parentImagesHtml}
                                        ${replyParentVideoHtml}
                                        ${this.generatePostStats(replyParentUri, replyParentCid, replyParentStats.replies, replyParentStats.likes, replyParentStats.reposts)}
                                    </div>
                                </div>
                          
                        `;
                    }

                    // Check for quote repost (handle both pure quotes and recordWithMedia)
                    let parentPostHtml = '';
                    let parentAuthor, parentText, parentUri, parentTime, parentFullDate, parentImages = [];
                    let parentStats = { likes: 0, replies: 0, reposts: 0 };
                    let parentCid = '';

                    // Pure quote embed
                    if (record.embed && record.embed.$type === 'app.bsky.embed.quote' && record.embed.quote) {
                        const quote = record.embed.quote;
                        parentAuthor = quote.author;
                        parentText = quote.record ? this.breakLongWords(quote.record.text) : '';
                        parentUri = quote.uri;
                        parentCid = quote.cid || '';
                        if (quote.record) {
                            const parentDate = new Date(quote.record.createdAt);
                            parentTime = this.formatTimeAgo(parentDate);
                            parentFullDate = parentDate.toLocaleString();
                        }

                        // Extract stats from quote parent post
                        parentStats = {
                            likes: quote.likeCount || 0,
                            replies: quote.replyCount || 0,
                            reposts: quote.repostCount || 0
                        };

                        // Extract images from parent post
                        if (quote.embeds && quote.embeds.length > 0) {
                            quote.embeds.forEach(embed => {
                                if (embed.images) {
                                    parentImages = embed.images;
                                } else if (embed.media && embed.media.images) {
                                    parentImages = embed.media.images;
                                } else if (embed.$type === 'app.bsky.embed.external#view' && embed.external) {
                                    // Handle GIF/WebP/media-only posts
                                    const externalUri = embed.external.uri;
                                    if (externalUri && /\.(gif|webp|mp4|webm)(\?|$)/i.test(externalUri)) {
                                        parentImages = [{ thumb: externalUri, fullsize: externalUri, alt: embed.external.description || 'Media' }];
                                    }
                                }
                            });
                        }
                    }
                    // Record embed view (returned from API thread view)
                    else if (post.embed && post.embed.$type === 'app.bsky.embed.record#view' && post.embed.record && post.embed.record.value) {
                        const viewRecord = post.embed.record.value;
                        parentAuthor = post.embed.record.author;
                        parentText = viewRecord.text ? this.breakLongWords(viewRecord.text) : '';
                        parentUri = post.embed.record.uri;
                        parentCid = post.embed.record.cid || '';
                        if (viewRecord) {
                            const parentDate = new Date(viewRecord.createdAt);
                            parentTime = this.formatTimeAgo(parentDate);
                            parentFullDate = parentDate.toLocaleString();
                        }

                        // Extract stats from quote parent post
                        parentStats = {
                            likes: post.embed.record.likeCount || 0,
                            replies: post.embed.record.replyCount || 0,
                            reposts: post.embed.record.repostCount || 0
                        };

                        // Extract images from parent post value
                        if (viewRecord.embed && viewRecord.embed.images) {
                            parentImages = viewRecord.embed.images;
                        } else if (viewRecord.embed && viewRecord.embed.$type === 'app.bsky.embed.external#view' && viewRecord.embed.external) {
                            // Handle GIF/WebP/media-only posts
                            const externalUri = viewRecord.embed.external.uri;
                            if (externalUri && /\.(gif|webp|mp4|webm)(\?|$)/i.test(externalUri)) {
                                parentImages = [{ thumb: externalUri, fullsize: externalUri, alt: viewRecord.embed.external.description || 'Media' }];
                            }
                        } else if (post.embed.record.embeds && post.embed.record.embeds.length > 0) {
                            // Also check embeds on the record object for nested media
                            post.embed.record.embeds.forEach(embed => {
                                if (embed.images) {
                                    parentImages = embed.images;
                                } else if (embed.media && embed.media.images) {
                                    parentImages = embed.media.images;
                                } else if (embed.$type === 'app.bsky.embed.external#view' && embed.external) {
                                    // Handle GIF/WebP/media-only posts
                                    const externalUri = embed.external.uri;
                                    if (externalUri && /\.(gif|webp|mp4|webm)(\?|$)/i.test(externalUri)) {
                                        parentImages = [{ thumb: externalUri, fullsize: externalUri, alt: embed.external.description || 'Media' }];
                                    }
                                }
                            });
                        }
                    }
                    // Quote within recordWithMedia - use the VIEW structure (post.embed, not post.record.embed)
                    else if (post.embed && post.embed.$type === 'app.bsky.embed.recordWithMedia#view' && post.embed.record && post.embed.record.record) {
                        const viewRecord = post.embed.record.record;
                        parentAuthor = viewRecord.author;
                        parentText = viewRecord.value ? this.breakLongWords(viewRecord.value.text) : '';
                        parentUri = viewRecord.uri;
                        parentCid = viewRecord.cid || '';
                        if (viewRecord.value) {
                            const parentDate = new Date(viewRecord.value.createdAt);
                            parentTime = this.formatTimeAgo(parentDate);
                            parentFullDate = parentDate.toLocaleString();
                        }

                        // Extract stats from quote parent post
                        parentStats = {
                            likes: viewRecord.likeCount || 0,
                            replies: viewRecord.replyCount || 0,
                            reposts: viewRecord.repostCount || 0
                        };

                        // Extract images from parent post
                        if (viewRecord.embeds && viewRecord.embeds.length > 0) {
                            viewRecord.embeds.forEach(embed => {
                                // Handle both simple image embeds and recordWithMedia embeds
                                if (embed.images) {
                                    parentImages = embed.images;
                                } else if (embed.media && embed.media.images) {
                                    parentImages = embed.media.images;
                                } else if (embed.$type === 'app.bsky.embed.external#view' && embed.external) {
                                    // Handle GIF/WebP/media-only posts
                                    const externalUri = embed.external.uri;
                                    if (externalUri && /\.(gif|webp|mp4|webm)(\?|$)/i.test(externalUri)) {
                                        parentImages = [{ thumb: externalUri, fullsize: externalUri, alt: embed.external.description || 'Media' }];
                                    }
                                }
                            });
                        }
                    }

                    if (parentAuthor && parentUri && (parentText || parentImages.length > 0)) {
                        const parentDisplayName = parentAuthor.displayName || parentAuthor.handle;
                        const parentAvatarHtml = this.getAvatarHtml(parentAuthor);

                        // Build parent post images HTML
                        let parentImagesHtml = '';
                        if (parentImages.length > 0) {
                            parentImagesHtml = '<div class="post-parent-images">';
                            // Collect all image URLs
                            const quoteImageUrls = this.extractImageUrls(parentImages, parentAuthor.did);
                            parentImages.forEach((img, index) => {
                                let imageUrl = quoteImageUrls[index];
                                const alt = this.escapeHtml(img.alt || 'Parent post image').replace(/"/g, '&quot;');
                                if (imageUrl) {
                                    parentImagesHtml += `<img src="${imageUrl}" alt="${alt}" class="post-parent-image" onclick="app.openImageModalFromEl(this)" />`;
                                } else if (img.image?.ref?.$link) {
                                    parentImagesHtml += `<img alt="${alt}" class="post-parent-image" data-author-did="${parentAuthor.did}" data-image-cid="${img.image.ref.$link}" onclick="app.openImageModalFromEl(this)" />`;
                                }
                            });
                            parentImagesHtml += '</div>';
                        }

                        parentPostHtml = `
                                <div class="post-parent-container">
                                    <div class="post-parent-header">
                                        <div class="post-parent-avatar">${parentAvatarHtml}</div>
                                        <div class="post-parent-author-info">
                                            <div class="post-parent-author-name">
                                                <a href="https://bsky.app/profile/${parentAuthor.did}" class="post-author-link" target="_blank" rel="noopener noreferrer">
                                                    ${parentDisplayName}
                                                </a>
                                            </div>
                                            <div class="post-parent-author-handle">@${parentAuthor.handle} · <a href="https://bsky.app/profile/${parentAuthor.did}/post/${parentUri.split('/').pop()}" class="post-timestamp" title="${parentFullDate}" target="_blank" rel="noopener noreferrer">${parentTime}</a></div>
                                        </div>
                                    </div>
                                    <div class="post-parent-body">
                                       <a href="https://bsky.app/profile/${parentAuthor.did}/post/${parentUri.split('/').pop()}" class="post-parent-link-wrapper" target="_blank" rel="noopener noreferrer">
                                        <div class="post-parent-text">${parentText}</div>
                                        </a>
                                        ${parentImagesHtml}
                                        ${this.generatePostStats(parentUri, parentCid, parentStats.replies, parentStats.likes, parentStats.reposts)}
                                    </div>
                                </div>
                           
                        `;
                    }

                    postEl.innerHTML = `
                        <div class="post-header">
                            <a href="https://bsky.app/profile/${author.did}" class="post-avatar-link" target="_blank" rel="noopener noreferrer">
                                <div class="post-avatar">${avatarHtml}</div>
                            </a>
                            <div class="post-info">
                                <div>
                                    <a href="https://bsky.app/profile/${author.did}" class="post-author-link" target="_blank" rel="noopener noreferrer">
                                        <span class="post-author">${author.displayName || author.handle}</span>
                                        <span class="post-handle">@${author.handle}</span>
                                    </a>
                                    <span class="post-time">
                                        <a href="https://bsky.app/profile/${author.did}/post/${post.uri.split('/').pop()}" class="post-timestamp" title="${fullDate}" target="_blank" rel="noopener noreferrer">${timeAgo}</a>
                                        </span>
                                </div>
                                ${item.reason && item.reason.$type === 'app.bsky.feed.defs#reasonRepost' ? `<div class="post-repost-info">🔄 Reposted by <a href="https://bsky.app/profile/${item.reason.by.did}" class="post-repost-link" target="_blank" rel="noopener noreferrer">${item.reason.by.displayName || item.reason.by.handle}</a></div>` : ''}
                                ${record.reply && record.reply.parent ? `<div class="post-reply-info">↩️ <span style="color: #1185fe; font-weight: 600;">Reply</span> <button style="background: none; border: none; color: #1185fe; cursor: pointer; padding: 0; margin-left: 8px; text-decoration: underline; font-size: 12px;" onclick="event.stopPropagation(); app.openThreadViewer('${post.uri}')">View Thread</button></div>` : ''}
                            </div>
                        </div>
                        ${replyParentPostHtml}
                        <a href="https://bsky.app/profile/${author.did}/post/${post.uri.split('/').pop()}" class="post-link" target="_blank" rel="noopener noreferrer">
                            <div class="post-text">${this.breakLongWords(record.text)}</div>
                        </a>
                        ${imagesHtml}
                        ${videoHtml}
                        ${parentPostHtml}
                        ${this.generatePostStats(post.uri, post.cid, post.replyCount, post.likeCount, post.repostCount)}
                    `;

                    fragment.appendChild(postEl);
                });

                // Attach event listeners for like/repost/bookmark buttons (query fragment before
                // appending to avoid re-attaching listeners to already-rendered buttons on subsequent pages)
                const likeButtons = fragment.querySelectorAll('button[data-action="like"]');
                const repostButtons = fragment.querySelectorAll('button[data-action="repost"]');
                const bookmarkButtons = fragment.querySelectorAll('button[data-action="bookmark"]');

                // Track image load requests — query fragment before appendChild so we get
                // references before they move to the live DOM and start loading
                fragment.querySelectorAll('img').forEach(img => {
                    pendingFetches.push(new Promise(resolve => {
                        if (img.complete) { resolve(); return; }
                        img.onload = resolve;
                        img.onerror = resolve; // resolve on error too — don't hang on broken images
                    }));
                });

                // Videos are click-to-load (see loadAndPlayVideo) so there's nothing to wait on here.

                // Append all posts at once (single DOM reflow) — images begin loading now
                this.resolvePendingImageSources(fragment);
                if (options.insertBefore) {
                    options.insertBefore.before(fragment);
                } else {
                    feed.appendChild(fragment);
                }
                
                likeButtons.forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        const postUri = btn.getAttribute('data-uri');
                        const postCid = btn.getAttribute('data-cid');
                        const account = btn.getAttribute('data-account');
                        if (account) {
                            this.toggleLike(postUri, postCid, account);
                        } else {
                            this.toggleLike(postUri, postCid);
                        }
                    });
                });
                
                repostButtons.forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        const postUri = btn.getAttribute('data-uri');
                        const postCid = btn.getAttribute('data-cid');
                        const account = btn.getAttribute('data-account');
                        if (account) {
                            this.toggleRepost(postUri, postCid, account);
                        } else {
                            this.toggleRepost(postUri, postCid);
                        }
                    });
                });

                bookmarkButtons.forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        const postUri = btn.getAttribute('data-uri');
                        const postCid = btn.getAttribute('data-cid');
                        const account = btn.getAttribute('data-account');
                        if (account) {
                            this.toggleBookmark(postUri, postCid, account);
                        } else {
                            this.toggleBookmark(postUri, postCid);
                        }
                    });
                });

                if (options.updateState !== false) {
                this.displayedCount += newPosts.length;

                // Update stats with filtered count (uses filteredPostsCache so dedup is reflected)
                const filteredTotal = this.filteredPostsCache ? this.filteredPostsCache.length : (startDate ? this.allPosts.filter(item =>
                    this.getPostDate(item).toISOString() >= startDate
                ).length : this.allPosts.length);

                const stats = document.getElementById('feedStats');
                const statsText = document.getElementById('feedStatsText');
                if (this.followedAccounts.length > 0) {
                    statsText.textContent = `👥 Following ${this.followedAccounts.length} accounts | 📮 Collected ${this.allPosts.length} posts | 📋 In range ${filteredTotal} posts | 👀 Displaying ${this.displayedCount} posts`;
                    stats.style.display = 'flex';
                    document.body.classList.add('feed-stats-visible');
                }

                // Collapse posts far behind the live window now that a new batch has landed
                this.unloadOldPosts();
                }

                // Return any pending HTTP fetches (likes mode) so caller can await them
                return pendingFetches;
            }

            // Collapses posts at the front of the live window into a lightweight placeholder
            // once more than UNLOAD_THRESHOLD posts behind the newest batch are still rendered.
            // The placeholder is sized to match the removed content's height so scroll position
            // doesn't jump; the underlying post data stays in allPosts/filteredPostsCache.
            unloadOldPosts() {
                const feed = document.getElementById('feed');

                while ((this.displayedCount - this.renderedWindowStart) > (this.UNLOAD_THRESHOLD + this.UNLOAD_CHUNK)) {
                    const startNode = this.unloadPlaceholderEl ? this.unloadPlaceholderEl.nextSibling : feed.firstChild;
                    if (!startNode) break;

                    let node = startNode;
                    let lastNode = null;
                    let removedCount = 0;
                    while (node && removedCount < this.UNLOAD_CHUNK) {
                        lastNode = node;
                        if (node.classList && node.classList.contains('post')) removedCount++;
                        node = node.nextSibling;
                    }
                    if (!lastNode || removedCount === 0) break;

                    const top = startNode.getBoundingClientRect().top;
                    const bottom = lastNode.getBoundingClientRect().bottom;
                    const height = Math.max(0, bottom - top);

                    let cur = startNode;
                    while (cur) {
                        const next = cur.nextSibling;
                        const isLast = cur === lastNode;
                        cur.remove();
                        cur = isLast ? null : next;
                    }

                    if (!this.unloadPlaceholderEl) {
                        const ph = document.createElement('div');
                        ph.className = 'unloaded-posts-placeholder';
                        feed.insertBefore(ph, feed.firstChild);
                        this.unloadPlaceholderEl = ph;
                        this.unloadObserver = new IntersectionObserver((entries) => {
                            if (entries[0].isIntersecting) this.restoreOldPosts();
                        }, { root: null, rootMargin: '800px 0px 0px 0px', threshold: 0 });
                        this.unloadObserver.observe(ph);
                    }
                    const prevHeight = parseFloat(this.unloadPlaceholderEl.style.minHeight) || 0;
                    this.unloadPlaceholderEl.style.minHeight = `${prevHeight + height}px`;
                    this.unloadedChunks.push({ count: removedCount, height });
                    this.renderedWindowStart += removedCount;
                }
            }

            // Re-renders the most recently unloaded chunk (LIFO — it's the one immediately
            // behind the current live window) when the user scrolls back up near the placeholder.
            restoreOldPosts() {
                if (!this.unloadPlaceholderEl || this.unloadedChunks.length === 0) return;

                const chunk = this.unloadedChunks.pop();
                const startIdx = this.renderedWindowStart - chunk.count;
                const filteredPosts = this.filteredPostsCache || [];
                const items = filteredPosts.slice(startIdx, this.renderedWindowStart);
                const insertBefore = this.unloadPlaceholderEl.nextSibling;

                this.renderPage({ items, insertBefore, updateState: false });
                this.renderedWindowStart = startIdx;

                if (this.unloadedChunks.length === 0) {
                    this.unloadObserver.disconnect();
                    this.unloadObserver = null;
                    this.unloadPlaceholderEl.remove();
                    this.unloadPlaceholderEl = null;
                } else {
                    const prevHeight = parseFloat(this.unloadPlaceholderEl.style.minHeight) || 0;
                    this.unloadPlaceholderEl.style.minHeight = `${Math.max(0, prevHeight - chunk.height)}px`;
                }
            }

            formatTimeAgo(date) {
                const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
                const minutes = Math.floor(seconds / 60);
                const hours = Math.floor(minutes / 60);
                const days = Math.floor(hours / 24);

                if (seconds < 60) return 'now';
                if (minutes < 60) return `${minutes}m`;
                if (hours < 24) return `${hours}h`;
                if (days < 7) return `${days}d`;

                return date.toLocaleDateString();
            }

            escapeHtml(text) {
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }

            getAvatarHtml(author) {
                // Renders an avatar <img>, falling back to initials when the author has no
                // avatar (or it previously failed to load). Remembers known-good avatar URLs
                // per DID so later/earlier posts by the same author can be backfilled.
                if (!author) return '?';

                const initial = (author.handle || '?').charAt(0).toUpperCase();
                let avatarUrl = author.avatar;

                if (avatarUrl) {
                    this.avatarCache.set(author.did, avatarUrl);
                    // A real avatar showed up — fix any initials shown earlier in the feed
                    if (!this.isAvatarUrlCoolingDown(avatarUrl)) {
                        this.backfillAvatarsForDid(author.did, avatarUrl);
                    }
                } else {
                    avatarUrl = this.avatarCache.get(author.did) || null;
                }

                if (avatarUrl && !this.isAvatarUrlCoolingDown(avatarUrl)) {
                    return `<img src="${this.escapeHtml(avatarUrl)}" alt="${this.escapeHtml(author.handle || '')}" data-author-did="${this.escapeHtml(author.did || '')}" data-author-initial="${this.escapeHtml(initial)}">`;
                }

                return `<span class="avatar-initial-fallback" data-author-did="${this.escapeHtml(author.did || '')}">${this.escapeHtml(initial)}</span>`;
            }

            isAvatarUrlCoolingDown(avatarUrl) {
                const failedAt = this.failedAvatarUrls.get(avatarUrl);
                if (!failedAt) return false;
                if (Date.now() - failedAt < 60000) return true;
                this.failedAvatarUrls.delete(avatarUrl);
                return false;
            }

            backfillAvatarsForDid(did, avatarUrl) {
                // Swap any initials placeholders already in the DOM for this author to the
                // real avatar now that it's known — "reload" avatars that rendered too early.
                if (!did || !avatarUrl) return;
                document.querySelectorAll(`.avatar-initial-fallback[data-author-did="${CSS.escape(did)}"]`).forEach(placeholder => {
                    const img = document.createElement('img');
                    img.src = avatarUrl;
                    img.alt = '';
                    img.dataset.authorDid = did;
                    img.dataset.authorInitial = placeholder.textContent || '?';
                    placeholder.replaceWith(img);
                });
            }

            breakLongWords(text, maxLen = 60) {
                // Split on whitespace (preserving whitespace tokens), then break
                // any token longer than maxLen characters and mark each break point.
                if (!text) return '';
                const tokens = text.split(/(\s+)/);
                return tokens.map(token => {
                    if (/^\s+$/.test(token) || token.length <= maxLen) {
                        return this.escapeHtml(token);
                    }
                    const parts = [];
                    for (let i = 0; i < token.length; i += maxLen) {
                        parts.push(this.escapeHtml(token.slice(i, i + maxLen)));
                    }
                    return parts.join('<span class="word-break-indicator">↵</span><br>');
                }).join('');
            }

            extractImageUrls(images, authorDid) {
                // Index-aligned with `images` (no filtering) so callers can pair each URL back to
                // its source image. Raw blob refs resolve to null — not a guessed bsky.social URL —
                // when the author's PDS isn't known yet; see resolvePendingImageSources.
                return images.map(img => {
                    if (img.thumb) return img.thumb;
                    if (img.fullsize) return img.fullsize;
                    if (img.image?.ref?.$link) {
                        return this.pdsCache.has(authorDid) ? this.getBlobUrl(authorDid, img.image.ref.$link) : null;
                    }
                    return null;
                });
            }

            async toggleLike(postUri, postCid, account = null) {
                if (!this.authToken) {
                    this.showLoginModal();
                    return;
                }

                // Determine which account to use
                if (!account && this.activeAccounts.length >= 2) {
                    // Multi-account mode: figure out from button's data
                    console.warn('Account not specified in multi-account mode');
                    return;
                }

                if (account && this.activeAccounts.length >= 2) {
                    // Multi-account mode: use specified account
                    const accountData = this.accounts[account];
                    if (!accountData) {
                        console.error(`Account ${account} not found`);
                        return;
                    }

                    try {
                        const targetMap = account === 'A' ? this.likedPosts_A : this.likedPosts_B;
                        const isLiked = targetMap.has(postUri);
                        
                        // Apply optimistic update: set buttons to the target state explicitly
                        const applyLikeState = (active) => {
                            document.querySelectorAll(`button[data-action="like"][data-account="${account}"][data-uri="${postUri}"]`).forEach(btn => {
                                if (active) btn.classList.add('liked'); else btn.classList.remove('liked');
                            });
                        };
                        applyLikeState(!isLiked); // optimistic

                        if (isLiked) {
                            // Unlike
                            const likeUri = targetMap.get(postUri);
                            const rkey = likeUri.split('/').pop();

                            const delResp = await this.repoRecordFetch(accountData.did, accountData.token, 'com.atproto.repo.deleteRecord', {
                                    repo: accountData.did,
                                    collection: 'app.bsky.feed.like',
                                    rkey: rkey
                                });
                            if (delResp.ok) {
                                targetMap.delete(postUri);
                            } else {
                                applyLikeState(true); // revert
                                throw new Error(`HTTP ${delResp.status}`);
                            }
                        } else {
                            // Like
                            const response = await this.repoRecordFetch(accountData.did, accountData.token, 'com.atproto.repo.createRecord', {
                                    repo: accountData.did,
                                    collection: 'app.bsky.feed.like',
                                    record: {
                                        $type: 'app.bsky.feed.like',
                                        subject: {
                                            uri: postUri,
                                            cid: postCid
                                        },
                                        createdAt: new Date().toISOString()
                                    }
                                });

                            if (response.ok) {
                                const data = await response.json();
                                targetMap.set(postUri, data.uri);
                            } else {
                                applyLikeState(false); // revert
                                throw new Error(`HTTP ${response.status}`);
                            }
                        }

                        // Update counts on all instances for this account
                        document.querySelectorAll(`button[data-action="like"][data-account="${account}"][data-uri="${postUri}"]`).forEach(btn => {
                            const countSpan = btn.querySelector('span.like-count');
                            if (countSpan) {
                                const currentCount = parseInt(countSpan.textContent) || 0;
                                countSpan.textContent = isLiked ? Math.max(0, currentCount - 1) : currentCount + 1;
                            }
                        });

                        // Save interaction state to cache
                        await this.saveInteractionState(account);
                    } catch (error) {
                        console.error(`Like toggle error for account ${account}:`, error);
                        alert(`Failed to update like for account ${account}`);
                    }
                } else {
                    // Single account mode: use account-specific map if available, or legacy map
                    try {
                        // Use account-specific map if single account is active, otherwise use legacy map
                        const singleSlot = this.activeAccounts.length === 1 ? this.activeAccounts[0] : null;
                        const { likedMap: targetMap } = this.getMapsForSlot(singleSlot);
                        const isLiked = targetMap.has(postUri);

                        // Apply optimistic update explicitly to target state
                        const applyLikeState = (active) => {
                            document.querySelectorAll(`button[data-action="like"][data-uri="${postUri}"]`).forEach(btn => {
                                if (active) btn.classList.add('liked'); else btn.classList.remove('liked');
                            });
                        };
                        applyLikeState(!isLiked); // optimistic

                        if (isLiked) {
                            // Unlike
                            const likeUri = targetMap.get(postUri);
                            const rkey = likeUri.split('/').pop();

                            const delResp = await this.repoRecordFetch(this.userDid, this.authToken, 'com.atproto.repo.deleteRecord', {
                                    repo: this.userDid,
                                    collection: 'app.bsky.feed.like',
                                    rkey: rkey
                                });
                            if (delResp.ok) {
                                targetMap.delete(postUri);
                            } else {
                                applyLikeState(true); // revert
                                throw new Error(`HTTP ${delResp.status}`);
                            }
                        } else {
                            // Like
                            const response = await this.repoRecordFetch(this.userDid, this.authToken, 'com.atproto.repo.createRecord', {
                                    repo: this.userDid,
                                    collection: 'app.bsky.feed.like',
                                    record: {
                                        $type: 'app.bsky.feed.like',
                                        subject: {
                                            uri: postUri,
                                            cid: postCid
                                        },
                                        createdAt: new Date().toISOString()
                                    }
                                });

                            if (response.ok) {
                                const data = await response.json();
                                targetMap.set(postUri, data.uri);
                            } else {
                                applyLikeState(false); // revert
                                throw new Error(`HTTP ${response.status}`);
                            }
                        }

                        // Update counts on all instances
                        document.querySelectorAll(`span.like-count[data-uri="${postUri}"]`).forEach(span => {
                            const currentCount = parseInt(span.textContent) || 0;
                            span.textContent = isLiked ? Math.max(0, currentCount - 1) : currentCount + 1;
                        });

                        // Save interaction state to cache (for single account with active slot)
                        if (singleSlot) {
                            await this.saveInteractionState(singleSlot);
                        }
                    } catch (error) {
                        console.error('Like toggle error:', error);
                        alert('Failed to update like');
                        applyLikeState(isLiked); // revert to original state
                    }
                }
            }

            async toggleRepost(postUri, postCid, account = null) {
                if (!this.authToken) {
                    this.showLoginModal();
                    return;
                }

                // Determine which account to use
                if (!account && this.activeAccounts.length >= 2) {
                    console.warn('Account not specified in multi-account mode');
                    return;
                }

                if (account && this.activeAccounts.length >= 2) {
                    // Multi-account mode: use specified account
                    const accountData = this.accounts[account];
                    if (!accountData) {
                        console.error(`Account ${account} not found`);
                        return;
                    }

                    try {
                        const targetMap = account === 'A' ? this.repostedPosts_A : this.repostedPosts_B;
                        const isReposted = targetMap.has(postUri);
                        
                        // Apply optimistic update: set buttons to the target state explicitly
                        const applyRepostState = (active) => {
                            document.querySelectorAll(`button[data-action="repost"][data-account="${account}"][data-uri="${postUri}"]`).forEach(btn => {
                                if (active) btn.classList.add('reposted'); else btn.classList.remove('reposted');
                            });
                        };
                        applyRepostState(!isReposted); // optimistic

                        if (isReposted) {
                            // Unrepost
                            const repostUri = targetMap.get(postUri);
                            const rkey = repostUri.split('/').pop();

                            const delResp = await this.repoRecordFetch(accountData.did, accountData.token, 'com.atproto.repo.deleteRecord', {
                                    repo: accountData.did,
                                    collection: 'app.bsky.feed.repost',
                                    rkey: rkey
                                });
                            if (delResp.ok) {
                                targetMap.delete(postUri);
                            } else {
                                applyRepostState(true); // revert
                                throw new Error(`HTTP ${delResp.status}`);
                            }
                        } else {
                            // Repost
                            const response = await this.repoRecordFetch(accountData.did, accountData.token, 'com.atproto.repo.createRecord', {
                                    repo: accountData.did,
                                    collection: 'app.bsky.feed.repost',
                                    record: {
                                        $type: 'app.bsky.feed.repost',
                                        subject: {
                                            uri: postUri,
                                            cid: postCid
                                        },
                                        createdAt: new Date().toISOString()
                                    }
                                });

                            if (response.ok) {
                                const data = await response.json();
                                targetMap.set(postUri, data.uri);
                            } else {
                                applyRepostState(false); // revert
                                throw new Error(`HTTP ${response.status}`);
                            }
                        }

                        // Update counts on all instances for this account
                        document.querySelectorAll(`button[data-action="repost"][data-account="${account}"][data-uri="${postUri}"]`).forEach(btn => {
                            const countSpan = btn.querySelector('span.repost-count');
                            if (countSpan) {
                                const currentCount = parseInt(countSpan.textContent) || 0;
                                countSpan.textContent = isReposted ? Math.max(0, currentCount - 1) : currentCount + 1;
                            }
                        });

                        // Save interaction state to cache
                        await this.saveInteractionState(account);
                    } catch (error) {
                        console.error(`Repost toggle error for account ${account}:`, error);
                        alert(`Failed to update repost for account ${account}`);
                    }
                } else {
                    // Single account mode: use account-specific map if available, or legacy map
                    try {
                        // Use account-specific map if single account is active, otherwise use legacy map
                        const singleSlot = this.activeAccounts.length === 1 ? this.activeAccounts[0] : null;
                        const { repostedMap: targetMap } = this.getMapsForSlot(singleSlot);
                        const isReposted = targetMap.has(postUri);

                        // Apply optimistic update explicitly to target state
                        const applyRepostState = (active) => {
                            document.querySelectorAll(`button[data-action="repost"][data-uri="${postUri}"]`).forEach(btn => {
                                if (active) btn.classList.add('reposted'); else btn.classList.remove('reposted');
                            });
                        };
                        applyRepostState(!isReposted); // optimistic

                        if (isReposted) {
                            // Unrepost
                            const repostUri = targetMap.get(postUri);
                            const rkey = repostUri.split('/').pop();

                            const delResp = await this.repoRecordFetch(this.userDid, this.authToken, 'com.atproto.repo.deleteRecord', {
                                    repo: this.userDid,
                                    collection: 'app.bsky.feed.repost',
                                    rkey: rkey
                                });
                            if (delResp.ok) {
                                targetMap.delete(postUri);
                            } else {
                                applyRepostState(true); // revert
                                throw new Error(`HTTP ${delResp.status}`);
                            }
                        } else {
                            // Repost
                            const response = await this.repoRecordFetch(this.userDid, this.authToken, 'com.atproto.repo.createRecord', {
                                    repo: this.userDid,
                                    collection: 'app.bsky.feed.repost',
                                    record: {
                                        $type: 'app.bsky.feed.repost',
                                        subject: {
                                            uri: postUri,
                                            cid: postCid
                                        },
                                        createdAt: new Date().toISOString()
                                    }
                                });

                            if (response.ok) {
                                const data = await response.json();
                                targetMap.set(postUri, data.uri);
                            } else {
                                applyRepostState(false); // revert
                                throw new Error(`HTTP ${response.status}`);
                            }
                        }

                        // Update counts on all instances
                        document.querySelectorAll(`span.repost-count[data-uri="${postUri}"]`).forEach(span => {
                            const currentCount = parseInt(span.textContent) || 0;
                            span.textContent = isReposted ? Math.max(0, currentCount - 1) : currentCount + 1;
                        });

                        // Save interaction state to cache (for single account with active slot)
                        if (singleSlot) {
                            await this.saveInteractionState(singleSlot);
                        }
                    } catch (error) {
                        console.error('Repost toggle error:', error);
                        alert('Failed to update repost');
                        applyRepostState(isReposted); // revert to original state
                    }
                }
            }

            async toggleBookmark(postUri, postCid, account = null) {
                if (!this.authToken) {
                    this.showLoginModal();
                    return;
                }

                // Determine which account to use
                if (!account && this.activeAccounts.length >= 2) {
                    console.warn('Account not specified in multi-account mode');
                    return;
                }

                // Bookmarks are a private per-account toggle (app.bsky.bookmark.*) — unlike
                // likes/reposts there's no shareable record URI to delete, just the post URI.
                const token = (account && this.activeAccounts.length >= 2)
                    ? this.accounts[account]?.token
                    : this.authToken;

                if (account && this.activeAccounts.length >= 2 && !token) {
                    console.error(`Account ${account} not found`);
                    return;
                }

                const slot = (account && this.activeAccounts.length >= 2)
                    ? account
                    : (this.activeAccounts.length === 1 ? this.activeAccounts[0] : null);
                const { bookmarkedSet: targetSet } = this.getMapsForSlot(slot);
                const isBookmarked = targetSet.has(postUri);

                const selector = account
                    ? `button[data-action="bookmark"][data-account="${account}"][data-uri="${postUri}"]`
                    : `button[data-action="bookmark"][data-uri="${postUri}"]`;
                const applyBookmarkState = (active) => {
                    document.querySelectorAll(selector).forEach(btn => {
                        if (active) btn.classList.add('bookmarked'); else btn.classList.remove('bookmarked');
                    });
                };
                applyBookmarkState(!isBookmarked); // optimistic

                try {
                    const endpoint = isBookmarked
                        ? 'https://bsky.social/xrpc/app.bsky.bookmark.deleteBookmark'
                        : 'https://bsky.social/xrpc/app.bsky.bookmark.createBookmark';
                    const body = isBookmarked
                        ? { uri: postUri }
                        : { uri: postUri, cid: postCid };

                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(body)
                    });

                    if (!response.ok) {
                        applyBookmarkState(isBookmarked); // revert
                        throw new Error(`HTTP ${response.status}`);
                    }

                    if (isBookmarked) {
                        targetSet.delete(postUri);
                    } else {
                        targetSet.add(postUri);
                    }

                    if (slot) {
                        await this.saveInteractionState(slot);
                    }
                } catch (error) {
                    console.error(`Bookmark toggle error${account ? ` for account ${account}` : ''}:`, error);
                    alert('Failed to update bookmark');
                }
            }

            showError(message) {
                const feed = document.getElementById('feed');
                const errorEl = document.createElement('div');
                errorEl.className = 'error';
                errorEl.textContent = message;
                feed.insertBefore(errorEl, feed.firstChild);
            }

            generatePostStats(postUri, postCid, replyCount, likeCount, repostCount) {
                // Check if multi-account mode
                if (this.activeAccounts.length >= 2) {
                    // Multi-account mode
                    const isLiked_A = this.likedPosts_A.has(postUri);
                    const isLiked_B = this.likedPosts_B.has(postUri);
                    const isReposted_A = this.repostedPosts_A.has(postUri);
                    const isReposted_B = this.repostedPosts_B.has(postUri);
                    const isBookmarked_A = this.bookmarkedPosts_A.has(postUri);
                    const isBookmarked_B = this.bookmarkedPosts_B.has(postUri);
                    
                    if (this.DEBUG) {
                        console.log(`[generatePostStats] Multi-account - Post ${postUri.substring(0, 30)}... - A: liked=${isLiked_A}, reposted=${isReposted_A} | B: liked=${isLiked_B}, reposted=${isReposted_B}`);
                    }
                    
                    if (this.accountGroupedLayout) {
                        // NEW LAYOUT: Account-grouped
                        const likeBtnA = `<button class="post-action-button dual-acct-btn${isLiked_A ? ' liked' : ''}" data-action="like" data-account="A" data-uri="${postUri}" data-cid="${postCid}" title="Like as Account A">❤️ A</button>`;
                        const likeBtnB = `<button class="post-action-button dual-acct-btn${isLiked_B ? ' liked' : ''}" data-action="like" data-account="B" data-uri="${postUri}" data-cid="${postCid}" title="Like as Account B">❤️ B</button>`;
                        const repostBtnA = `<button class="post-action-button dual-acct-btn${isReposted_A ? ' reposted' : ''}" data-action="repost" data-account="A" data-uri="${postUri}" data-cid="${postCid}" title="Repost as Account A">🔄 A</button>`;
                        const repostBtnB = `<button class="post-action-button dual-acct-btn${isReposted_B ? ' reposted' : ''}" data-action="repost" data-account="B" data-uri="${postUri}" data-cid="${postCid}" title="Repost as Account B">🔄 B</button>`;
                        const bookmarkBtnA = `<button class="post-action-button dual-acct-btn${isBookmarked_A ? ' bookmarked' : ''}" data-action="bookmark" data-account="A" data-uri="${postUri}" data-cid="${postCid}" title="Bookmark as Account A">🔖 A</button>`;
                        const bookmarkBtnB = `<button class="post-action-button dual-acct-btn${isBookmarked_B ? ' bookmarked' : ''}" data-action="bookmark" data-account="B" data-uri="${postUri}" data-cid="${postCid}" title="Bookmark as Account B">🔖 B</button>`;
                        
                        return `<div class="post-stats">
                                    <div class="post-stat-group">
                                        <span class="post-stat">💬 ${replyCount || 0}</span>
                                    </div>
                                    <div class="new-interaction-bar">
                                        <span class="post-stat">❤️ ${likeCount || 0}</span>
                                        <span class="post-stat">🔄 ${repostCount || 0}</span>
                                        <div class="account-interaction-group">
                                            ${likeBtnA}
                                            ${repostBtnA}
                                            ${bookmarkBtnA}
                                        </div>
                                        <div class="account-separator">|</div>
                                        <div class="account-interaction-group">
                                            ${likeBtnB}
                                            ${repostBtnB}
                                            ${bookmarkBtnB}
                                        </div>
                                    </div>
                                </div>`;
                    } else {
                        // ORIGINAL LAYOUT: Type-grouped
                        // Like buttons
                        const likeBtnA = `<button class="post-action-button dual-acct-btn${isLiked_A ? ' liked' : ''}" data-action="like" data-account="A" data-uri="${postUri}" data-cid="${postCid}" title="Like as Account A">A</button>`;
                        const likeBtnB = `<button class="post-action-button dual-acct-btn${isLiked_B ? ' liked' : ''}" data-action="like" data-account="B" data-uri="${postUri}" data-cid="${postCid}" title="Like as Account B">B</button>`;
                        
                        // Repost buttons
                        const repostBtnA = `<button class="post-action-button dual-acct-btn${isReposted_A ? ' reposted' : ''}" data-action="repost" data-account="A" data-uri="${postUri}" data-cid="${postCid}" title="Repost as Account A">A</button>`;
                        const repostBtnB = `<button class="post-action-button dual-acct-btn${isReposted_B ? ' reposted' : ''}" data-action="repost" data-account="B" data-uri="${postUri}" data-cid="${postCid}" title="Repost as Account B">B</button>`;
                        
                        // Bookmark buttons
                        const bookmarkBtnA = `<button class="post-action-button dual-acct-btn${isBookmarked_A ? ' bookmarked' : ''}" data-action="bookmark" data-account="A" data-uri="${postUri}" data-cid="${postCid}" title="Bookmark as Account A">A</button>`;
                        const bookmarkBtnB = `<button class="post-action-button dual-acct-btn${isBookmarked_B ? ' bookmarked' : ''}" data-action="bookmark" data-account="B" data-uri="${postUri}" data-cid="${postCid}" title="Bookmark as Account B">B</button>`;
                        
                        return `<div class="post-stats">
                                    <div class="post-stat-group">
                                        <span class="post-stat">💬 ${replyCount || 0}</span>
                                    </div>
                                    <div class="post-stat-group">
                                        <span class="post-stat">❤️ ${likeCount || 0}</span>
                                        <div class="stat-separator"></div>
                                        <div class="stat-buttons">
                                            ${likeBtnA}
                                            ${likeBtnB}
                                        </div>
                                    </div>
                                    <div class="post-stat-group">
                                        <span class="post-stat">🔄 ${repostCount || 0}</span>
                                        <div class="stat-separator"></div>
                                        <div class="stat-buttons">
                                            ${repostBtnA}
                                            ${repostBtnB}
                                        </div>
                                    </div>
                                    <div class="post-stat-group">
                                        <span class="post-stat">🔖</span>
                                        <div class="stat-separator"></div>
                                        <div class="stat-buttons">
                                            ${bookmarkBtnA}
                                            ${bookmarkBtnB}
                                        </div>
                                    </div>
                                </div>`;
                    }
                } else {
                    // Single account mode: use the active account's map, or legacy map as fallback
                    const singleSlot = this.activeAccounts.length === 1 ? this.activeAccounts[0] : null;
                    const { likedMap, repostedMap, bookmarkedSet } = this.getMapsForSlot(singleSlot);
                    const isLiked = likedMap.has(postUri);
                    const isReposted = repostedMap.has(postUri);
                    const isBookmarked = bookmarkedSet.has(postUri);
                    
                    if (this.DEBUG) {
                        console.log(`[generatePostStats] Single-account - Post ${postUri.substring(0, 30)}... - liked=${isLiked}, reposted=${isReposted}`);
                    }
                    
                    const likeBtn = this.authToken ? 
                        `<button class="post-action-button${isLiked ? ' liked' : ''}" data-action="like" data-uri="${postUri}" data-cid="${postCid}">❤️ <span class="like-count" data-uri="${postUri}">${likeCount || 0}</span></button>` : 
                        `<span class="post-stat">❤️ ${likeCount || 0}</span>`;
                    
                    const repostBtn = this.authToken ? 
                        `<button class="post-action-button${isReposted ? ' reposted' : ''}" data-action="repost" data-uri="${postUri}" data-cid="${postCid}">🔄 <span class="repost-count" data-uri="${postUri}">${repostCount || 0}</span></button>` : 
                        `<span class="post-stat">🔄 ${repostCount || 0}</span>`;
                    
                    const bookmarkBtn = this.authToken ?
                        `<button class="post-action-button${isBookmarked ? ' bookmarked' : ''}" data-action="bookmark" data-uri="${postUri}" data-cid="${postCid}" title="Bookmark">🔖</button>` :
                        '';
                    
                    return `<div class="post-stats">
                                <span class="post-stat">💬 ${replyCount || 0}</span>
                                ${likeBtn}
                                ${repostBtn}
                                ${bookmarkBtn}
                            </div>`;
                }
            }

            createRateLimiter(requestsPerSecond) {
                const minInterval = 1000 / requestsPerSecond;
                // nextAllowedTime tracks the earliest ms the next request may fire.
                // Updated atomically so concurrent callers each get their own slot.
                let nextAllowedTime = 0;

                return {
                    wait: async () => {
                        const now = Date.now();
                        const scheduled = Math.max(now, nextAllowedTime);
                        nextAllowedTime = scheduled + minInterval;
                        const delay = scheduled - now;
                        if (delay > 0) {
                            await new Promise(resolve => setTimeout(resolve, delay));
                        }
                    }
                };
            }

            async resolveRepoDeactivatedFallback(response, actorOrDid) {
                // An account that migrated to a new PDS leaves its old host returning
                // RepoDeactivated/RepoNotFound/RepoTakendown instead of real data. When that
                // happens, force re-discovery of the actor's current PDS so the caller can retry.
                if (!actorOrDid || response.ok) return null;

                let body;
                try {
                    body = await response.clone().json();
                } catch (error) {
                    return null;
                }
                if (!['RepoDeactivated', 'RepoNotFound', 'RepoTakendown'].includes(body?.error)) return null;

                let did = actorOrDid;
                if (!did.startsWith('did:')) {
                    did = await this.resolveHandleToDid(did);
                    if (!did) return null;
                }

                // The cached PDS (if any) is the stale one that just failed — drop it and re-resolve
                this.pdsCache.delete(did);
                console.warn(`[PDS fallback] ${actorOrDid} returned ${body.error} — re-discovering current PDS`);
                return await this.discoverPds(did);
            }

            async bskyFetchForActor(actor, buildUrl, options = {}, initialBase = 'https://bsky.social') {
                // Like bskyFetch, but for requests scoped to a specific actor's repo: if the
                // host reports the repo deactivated/moved, retry once against their real PDS.
                let response = await this.bskyFetch(buildUrl(initialBase), options);
                if (!response.ok) {
                    const fallbackBase = await this.resolveRepoDeactivatedFallback(response, actor);
                    if (fallbackBase && fallbackBase !== initialBase) {
                        response = await this.bskyFetch(buildUrl(fallbackBase), options);
                    }
                }
                return response;
            }

            async repoRecordFetch(did, token, procedure, body) {
                // Creates/deletes a record in the acting account's own repo. Wrapped with the
                // same RepoDeactivated/PDS-fallback as reads, since a user who migrated their
                // own account to a custom PDS would otherwise fail to like/repost/bookmark too.
                return await this.bskyFetchForActor(
                    did,
                    base => `${base}/xrpc/${procedure}`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(body)
                    }
                );
            }

            // Bluesky rate limits: 3000 req / 5 min per IP on bsky.social (authenticated).
            // This wrapper reads RateLimit-* headers, proactively pauses when quota is
            // low, and automatically retries on HTTP 429.
            async bskyFetch(url, options = {}, maxRetries = 3) {
                // Proactively pause if the server already told us quota is nearly gone
                if ((url.includes('bsky.social') || url.includes('bsky.app')) &&
                    this._rateLimitRemaining !== null &&
                    this._rateLimitRemaining < 50) {
                    const waitMs = Math.max(1000, this._rateLimitReset - Date.now());
                    if (waitMs < 5 * 60 * 1000) {
                        this.updateStatus(`⏳ Rate limit low (${this._rateLimitRemaining} remaining), pausing ${Math.ceil(waitMs / 1000)}s...`);
                        await new Promise(resolve => setTimeout(resolve, waitMs));
                        this._rateLimitRemaining = null;
                    }
                }

                for (let attempt = 0; attempt <= maxRetries; attempt++) {
                    let response;
                    try {
                        response = await fetch(url, options);
                    } catch (networkError) {
                        // Network-level failure (offline, DNS, timeout, etc.) — retry with backoff
                        if (attempt === maxRetries) {
                            console.warn(`[bskyFetch] Network error after ${maxRetries} retries: ${url}`, networkError);
                            throw networkError;
                        }
                        const waitMs = Math.min(1000 * 2 ** attempt, 30000);
                        this.updateStatus(`⚠️ Network error. Retrying ${attempt + 1}/${maxRetries} in ${Math.ceil(waitMs / 1000)}s...`);
                        await new Promise(resolve => setTimeout(resolve, waitMs));
                        continue;
                    }

                    // Track server-reported quota from response headers
                    const remaining = response.headers.get('RateLimit-Remaining');
                    const reset = response.headers.get('RateLimit-Reset');
                    if (remaining !== null) this._rateLimitRemaining = parseInt(remaining, 10);
                    if (reset !== null) this._rateLimitReset = parseInt(reset, 10) * 1000; // Unix s → ms

                    // Only 429 and transient 5xx server errors are retryable
                    const retryable = response.status === 429 || response.status >= 500;
                    if (!retryable) {
                        return response;
                    }

                    if (attempt === maxRetries) {
                        console.warn(`[bskyFetch] Still failing (HTTP ${response.status}) after ${maxRetries} retries: ${url}`);
                        return response;
                    }

                    let waitMs;
                    if (response.status === 429) {
                        waitMs = 60000; // default: 60s
                        const retryAfter = response.headers.get('Retry-After');
                        if (retryAfter) {
                            waitMs = parseInt(retryAfter, 10) * 1000;
                        } else if (reset) {
                            waitMs = Math.max(1000, parseInt(reset, 10) * 1000 - Date.now());
                        }
                        waitMs = Math.min(waitMs, 5 * 60 * 1000); // cap at 5 minutes
                        this.updateStatus(`⚠️ Rate limited (429). Waiting ${Math.ceil(waitMs / 1000)}s before retry ${attempt + 1}/${maxRetries}...`);
                    } else {
                        // Transient server error (5xx) — short exponential backoff
                        waitMs = Math.min(1000 * 2 ** attempt, 30000);
                        this.updateStatus(`⚠️ Server error (${response.status}). Retrying ${attempt + 1}/${maxRetries} in ${Math.ceil(waitMs / 1000)}s...`);
                    }

                    console.warn(`[bskyFetch] ${response.status} on ${url} — waiting ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                }
            }

            decodeTidToDate(rkey) {
                // AT-proto TID: base32 string (alphabet: 234567abcdefghijklmnopqrstuvwxyz)
                // Encodes: (timestamp_microseconds << 10) | clock_id
                try {
                    if (!rkey) return null;
                    const alphabet = '234567abcdefghijklmnopqrstuvwxyz';
                    let n = BigInt(0);
                    for (const ch of rkey) {
                        const idx = alphabet.indexOf(ch);
                        if (idx === -1) return null;
                        n = n * 32n + BigInt(idx);
                    }
                    const microseconds = n >> 10n;
                    const milliseconds = Number(microseconds / 1000n);
                    return new Date(milliseconds).toISOString();
                } catch (e) {
                    return null;
                }
            }

            dateToTid(isoDate) {
                // Convert an ISO 8601 date string to an AT Protocol TID cursor.
                // Uses clock ID 1023 (max) so the cursor sits at the very end of that
                // microsecond, ensuring all records at exactly that timestamp are included.
                try {
                    const ms = new Date(isoDate).getTime();
                    if (isNaN(ms)) return undefined;
                    const microseconds = BigInt(ms) * 1000n;
                    const n = (microseconds << 10n) | 1023n;
                    const alphabet = '234567abcdefghijklmnopqrstuvwxyz';
                    let result = '';
                    let val = n;
                    for (let i = 0; i < 13; i++) {
                        result = alphabet[Number(val & 31n)] + result;
                        val >>= 5n;
                    }
                    return result;
                } catch (e) {
                    return undefined;
                }
            }

            getPostDate(item) {
                // For liked-mode placeholders, use the liked date if available
                if (item.placeholder) {
                    if (item.likedAt) return new Date(item.likedAt);
                    return new Date();
                }
                
                // Return epoch for items without post data
                if (!item.post) {
                    return new Date(0);
                }
                
                // Use reason.indexedAt if available (for reposts), otherwise use record.createdAt
                if (item.reason && item.reason.indexedAt) {
                    return new Date(item.reason.indexedAt);
                }
                return new Date(item.post.record.createdAt);
            }

            hasNoUnauthenticatedLabel(account) {
                // Check if profile has the "!no-unauthenticated" label
                if (account.labels && Array.isArray(account.labels)) {
                    return account.labels.some(label => label.val === '!no-unauthenticated');
                }
                return false;
            }

            extractViewerData(feed, accountSlot) {
                if (!feed || !accountSlot) return { liked: 0, reposted: 0 };

                const { likedMap: targetMap_liked, repostedMap: targetMap_reposted, bookmarkedSet: targetSet_bookmarked } = this.getMapsForSlot(accountSlot);
                let likedCount = 0, repostedCount = 0;

                feed.forEach(item => {
                    const post = item.post;
                    if (post.viewer) {
                        if (post.viewer.like) {
                            targetMap_liked.set(post.uri, post.viewer.like);
                            likedCount++;
                        }
                        if (post.viewer.repost) {
                            targetMap_reposted.set(post.uri, post.viewer.repost);
                            repostedCount++;
                        }
                        if (post.viewer.bookmarked) {
                            targetSet_bookmarked.add(post.uri);
                        }
                    }
                    // Also capture viewer data from reply parent
                    if (item.reply && item.reply.parent && item.reply.parent.viewer) {
                        const parent = item.reply.parent;
                        if (parent.viewer.like) {
                            targetMap_liked.set(parent.uri, parent.viewer.like);
                            likedCount++;
                        }
                        if (parent.viewer.repost) {
                            targetMap_reposted.set(parent.uri, parent.viewer.repost);
                            repostedCount++;
                        }
                        if (parent.viewer.bookmarked) {
                            targetSet_bookmarked.add(parent.uri);
                        }
                    }
                });

                return { liked: likedCount, reposted: repostedCount };
            }

            setupImagePreloadHandler() {
                document.addEventListener('mouseover', (event) => {
                    const img = event.target;
                    if (!this.imagePreloadingEnabled || !(img instanceof HTMLImageElement) ||
                        !img.matches('.post-image, .post-parent-image') || !img.getAttribute('src')) return;
                    this.preloadImage(img.currentSrc || img.src);
                });
            }

            preloadImage(imageUrl) {
                if (!this.imagePreloadingEnabled || !imageUrl || this.preloadedImages.has(imageUrl)) {
                    return; // Already preloaded
                }

                const img = new Image();
                img.onerror = () => this.preloadedImages.delete(imageUrl);
                this.preloadedImages.add(imageUrl);
                img.src = imageUrl;
            }

            openImageModalFromEl(imgEl) {
                // Reads URLs live from the DOM instead of a precomputed array, so it still works
                // for images whose src was patched in later by resolvePendingImageSources.
                const container = imgEl.closest('.post-images, .post-parent-images');
                const allImages = container
                    ? Array.from(container.querySelectorAll('img')).map(img => img.src).filter(Boolean)
                    : [imgEl.src];
                this.openImageModal(imgEl.src, allImages);
            }

            openImageModal(imageUrl, allImages = null) {
                const modal = document.getElementById('imageModal');
                const modalImage = document.getElementById('modalImage');
                const prevBtn = document.getElementById('imagePrevBtn');
                const nextBtn = document.getElementById('imageNextBtn');
                const counter = document.getElementById('imageCounter');
                
                modalImage.src = imageUrl;
                modal.classList.add('active');
                
                // Store images for navigation
                this.modalImages = allImages || [imageUrl];
                this.currentImageIndex = this.modalImages.indexOf(imageUrl);
                
                // Show/hide nav buttons and counter
                if (this.modalImages.length > 1) {
                    prevBtn.style.display = 'flex';
                    nextBtn.style.display = 'flex';
                    counter.style.display = 'block';
                    counter.textContent = `${this.currentImageIndex + 1} / ${this.modalImages.length}`;
                } else {
                    prevBtn.style.display = 'none';
                    nextBtn.style.display = 'none';
                    counter.style.display = 'none';
                }
                
                // Close modal when clicking outside the image
                modal.onclick = (e) => {
                    if (e.target === modal) {
                        this.closeImageModal();
                    }
                };
                
                // Add keyboard navigation
                this.keyboardHandler = (e) => {
                    if (e.key === 'ArrowLeft') {
                        e.preventDefault();
                        this.previousImage();
                    } else if (e.key === 'ArrowRight') {
                        e.preventDefault();
                        this.nextImage();
                    } else if (e.key === 'Escape') {
                        this.closeImageModal();
                    }
                };
                document.addEventListener('keydown', this.keyboardHandler);
            }

            previousImage() {
                if (this.modalImages && this.modalImages.length > 1) {
                    this.currentImageIndex = (this.currentImageIndex - 1 + this.modalImages.length) % this.modalImages.length;
                    this.updateModalImage();
                }
            }

            nextImage() {
                if (this.modalImages && this.modalImages.length > 1) {
                    this.currentImageIndex = (this.currentImageIndex + 1) % this.modalImages.length;
                    this.updateModalImage();
                }
            }

            updateModalImage() {
                const modalImage = document.getElementById('modalImage');
                const counter = document.getElementById('imageCounter');
                modalImage.src = this.modalImages[this.currentImageIndex];
                counter.textContent = `${this.currentImageIndex + 1} / ${this.modalImages.length}`;
            }

            closeImageModal() {
                const modal = document.getElementById('imageModal');
                modal.classList.remove('active');
                // Remove keyboard handler
                if (this.keyboardHandler) {
                    document.removeEventListener('keydown', this.keyboardHandler);
                    this.keyboardHandler = null;
                }
            }

            toggleDarkMode() {
                const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
                const newMode = isDarkMode ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', newMode);
                localStorage.setItem('theme', newMode);
                this.updateDarkModeButton();
            }

            restoreDarkMode() {
                const savedTheme = localStorage.getItem('theme') || 'light';
                document.documentElement.setAttribute('data-theme', savedTheme);
                this.updateDarkModeButton();
            }

            updateDarkModeButton() {
                const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
                const button = document.getElementById('darkModeToggle');
                if (button) {
                    button.textContent = isDarkMode ? '☀️' : '🌙';
                    button.title = isDarkMode ? 'Switch to light mode' : 'Switch to dark mode';
                }
            }

            toggleImagePreloading() {
                this.imagePreloadingEnabled = !this.imagePreloadingEnabled;
                localStorage.setItem('imagePreloadingEnabled', this.imagePreloadingEnabled);
                this.updatePreloadToggleButton();
            }

            updatePreloadToggleButton() {
                const btn = document.getElementById('preloadToggleBtn');
                if (btn) {
                    btn.textContent = this.imagePreloadingEnabled ? '✓ Image Preload' : '✗ Image Preload';
                    btn.title = this.imagePreloadingEnabled ? 'Disable image preloading' : 'Enable image preloading';
                }
            }

            restoreMuteBlockUI() {
                const btn = document.getElementById('muteBlockToggleBtn');
                if (btn) {
                    btn.textContent = this.muteBlockEnabled ? '🚫 Mute/Block: ON' : '🚫 Mute/Block: OFF';
                    btn.title = this.muteBlockEnabled ? 'Click to disable mute/block filtering' : 'Click to enable mute/block filtering';
                }
            }

            toggleMuteBlockFilter() {
                // Check authentication first
                if (!this.authToken) {
                    this.showLoginModal();
                    return;
                }
                
                this.muteBlockEnabled = !this.muteBlockEnabled;
                localStorage.setItem('muteBlockEnabled', this.muteBlockEnabled);
                this.updateMuteBlockToggleButton();
                
                // If enabling for first time and lists not loaded, load them
                if (this.muteBlockEnabled && !this.muteBlockListLoaded) {
                    this.loadMuteAndBlockLists();
                } else if (this.allPosts.length > 0) {
                    // Re-render feed when toggled
                    this.displayedCount = 0;
                    this.clearFeedDOM();
                    this.renderPage();
                }
            }

            updateMuteBlockToggleButton() {
                const btn = document.getElementById('muteBlockToggleBtn');
                if (btn) {
                    btn.textContent = this.muteBlockEnabled ? '🚫 Mute/Block: ON' : '🚫 Mute/Block: OFF';
                    btn.title = this.muteBlockEnabled ? 'Click to disable mute/block filtering' : 'Click to enable mute/block filtering';
                }
                this.updateFeedStats();
            }

            toggleAccountGroupedLayout() {
                this.accountGroupedLayout = !this.accountGroupedLayout;
                localStorage.setItem('accountGroupedLayout', this.accountGroupedLayout);
                this.updateLayoutToggleButton();
                // Re-render feed when toggled
                if (this.allPosts.length > 0) {
                    this.displayedCount = 0;
                    this.clearFeedDOM();
                    this.renderPage();
                }
            }

            updateLayoutToggleButton() {
                const btn = document.getElementById('layoutToggleBtn');
                if (btn) {
                    btn.textContent = this.accountGroupedLayout ? '📊 Grouped by Account' : '📊 Grouped by Type';
                    btn.title = this.accountGroupedLayout ? 'Switch to type-grouped layout' : 'Switch to account-grouped layout';
                }
            }

            toggleDeduplicatePosts() {
                this.deduplicatePosts = !this.deduplicatePosts;
                localStorage.setItem('deduplicatePosts', this.deduplicatePosts);
                this.updateDeduplicateButton();
                if (this.allPosts.length > 0) {
                    this.displayedCount = 0;
                    this.clearFeedDOM();
                    this.renderPage();
                }
            }

            togglePrefillTargetAccounts() {
                this.prefillTargetWithLoggedInAccounts = !this.prefillTargetWithLoggedInAccounts;
                localStorage.setItem('prefillTargetWithLoggedInAccounts', this.prefillTargetWithLoggedInAccounts);
                this.updatePrefillTargetButton();
                if (this.prefillTargetWithLoggedInAccounts) {
                    this.prefillTargetHandlesWithLoggedInAccounts();
                }
            }

            updatePrefillTargetButton() {
                const btn = document.getElementById('prefillTargetToggleBtn');
                if (btn) {
                    btn.textContent = this.prefillTargetWithLoggedInAccounts ? '✓ Prefill with Logged-in Accounts' : '✗ Prefill with Logged-in Accounts';
                    btn.title = this.prefillTargetWithLoggedInAccounts ? 'Click to stop prefilling target handles with logged-in accounts' : 'Click to prefill target handles with logged-in accounts';
                }
            }

            prefillTargetHandlesWithLoggedInAccounts() {
                if (!this.prefillTargetWithLoggedInAccounts) return;
                if (this.activeAccounts.length === 0) return;

                const handles = this.activeAccounts
                    .map(slot => this.accounts[slot]?.handle)
                    .filter(Boolean);
                if (handles.length === 0) return;

                const container = document.getElementById('handlesContainer');
                if (!container) return;

                const getInputs = () => Array.from(container.querySelectorAll('.handleInput'));
                const currentValues = getInputs().map(input => input.value.trim());

                handles.forEach(handle => {
                    if (currentValues.includes(handle)) return; // already present, don't duplicate

                    const emptyInput = getInputs().find(input => !input.value.trim());
                    if (emptyInput) {
                        emptyInput.value = handle;
                    } else {
                        this.addHandleInput();
                        const inputs = getInputs();
                        inputs[inputs.length - 1].value = handle;
                    }
                    currentValues.push(handle);
                });
            }

            updateDeduplicateButton() {
                const btn = document.getElementById('deduplicateBtn');
                if (btn) {
                    btn.textContent = this.deduplicatePosts ? '✓ Deduplicate Posts' : '✗ Deduplicate Posts';
                    btn.title = this.deduplicatePosts ? 'Click to show duplicate posts' : 'Click to hide duplicate posts';
                }
            }

            async fetchMutedAccounts() {
                const mutes = [];
                // Collect tokens for all active accounts, falling back to authToken
                const tokens = this.activeAccounts.length > 0
                    ? this.activeAccounts.map(s => this.accounts[s]?.token).filter(Boolean)
                    : (this.authToken ? [this.authToken] : []);

                for (const token of tokens) {
                    let cursor = null;
                    try {
                        while (true) {
                            const url = `https://bsky.social/xrpc/app.bsky.graph.getMutes?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
                            const response = await fetch(url, {
                                headers: { 'Authorization': `Bearer ${token}` }
                            });
                            if (!response.ok) break;
                            const data = await response.json();
                            if (data.mutes && Array.isArray(data.mutes)) {
                                mutes.push(...data.mutes.map(m => m.did));
                            }
                            if (!data.cursor) break;
                            cursor = data.cursor;
                        }
                    } catch (error) {
                        console.warn('Error fetching muted accounts:', error);
                    }
                }
                return mutes;
            }

            async fetchBlockedAccounts() {
                const blocks = [];
                // Collect tokens for all active accounts, falling back to authToken
                const tokens = this.activeAccounts.length > 0
                    ? this.activeAccounts.map(s => this.accounts[s]?.token).filter(Boolean)
                    : (this.authToken ? [this.authToken] : []);

                for (const token of tokens) {
                    let cursor = null;
                    try {
                        while (true) {
                            const url = `https://bsky.social/xrpc/app.bsky.graph.getBlocks?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
                            const response = await fetch(url, {
                                headers: { 'Authorization': `Bearer ${token}` }
                            });
                            if (!response.ok) break;
                            const data = await response.json();
                            if (data.blocks && Array.isArray(data.blocks)) {
                                blocks.push(...data.blocks.map(b => b.did));
                            }
                            if (!data.cursor) break;
                            cursor = data.cursor;
                        }
                    } catch (error) {
                        console.warn('Error fetching blocked accounts:', error);
                    }
                }
                return blocks;
            }

            async loadMuteAndBlockLists() {
                if (!this.authToken) {
                    console.warn('Not authenticated, cannot load mute/block lists');
                    return;
                }
                
                try {
                    this.updateStatus('🔄 Loading mute and block lists...');
                    
                    // Load both lists in parallel
                    const [mutedDids, blockedDids] = await Promise.all([
                        this.fetchMutedAccounts(),
                        this.fetchBlockedAccounts()
                    ]);
                    
                    // Store in Sets for fast lookup
                    this.mutedAccounts = new Set(mutedDids);
                    this.blockedAccounts = new Set(blockedDids);
                    this.muteBlockListLoaded = true;
                    
                    this.updateStatus(`✅ Loaded ${mutedDids.length} muted + ${blockedDids.length} blocked accounts`);
                    
                    // Re-render feed with filtering applied
                    if (this.allPosts.length > 0) {
                        this.displayedCount = 0;
                        this.clearFeedDOM();
                        this.renderPage();
                    }
                } catch (error) {
                    console.error('Error loading mute/block lists:', error);
                    this.updateStatus('❌ Failed to load mute/block lists');
                }
            }

            // ========== SIDEBAR & SEARCH FUNCTIONALITY ==========
            toggleRightSidebar() {
                const sidebar = document.getElementById('rightSidebar');
                sidebar.classList.toggle('open');
                localStorage.setItem('sidebarOpen', sidebar.classList.contains('open'));
            }

            handleSearch() {
                const searchInput = document.getElementById('searchInput');
                const keyword = searchInput.value.toLowerCase().trim();
                const resultsDiv = document.getElementById('searchResults');
                
                if (!keyword) {
                    resultsDiv.innerHTML = '';
                    // Reset position saved flag when search is cleared
                    this.positionSavedThisSession = false;
                    return;
                }

                const matches = this.allPosts.filter(item => {
                    const text = item.post.record.text.toLowerCase();
                    const author = item.post.author.handle.toLowerCase();
                    return text.includes(keyword) || author.includes(keyword);
                });

                if (matches.length === 0) {
                    resultsDiv.innerHTML = '<div class="search-no-results">No posts match your search</div>';
                    return;
                }

                // Limit to 20 results
                const limited = matches.slice(0, 20);
                resultsDiv.innerHTML = limited.map((item, idx) => `
                    <div class="search-result-item" onclick="app.scrollToPost('${item.post.uri}')">
                        <div class="search-result-author">@${this.escapeHtml(item.post.author.handle)}</div>
                        <div class="search-result-text">${this.escapeHtml(item.post.record.text.substring(0, 80))}${item.post.record.text.length > 80 ? '...' : ''}</div>
                    </div>
                `).join('');
            }

            scrollToPost(postUri) {
                // Save current scroll position before navigating (only once per search session)
                if (!this.positionSavedThisSession) {
                    this.lastScrollPosition = window.scrollY;
                    this.lastScrollTimestamp = Date.now();
                    this.positionSavedThisSession = true;
                    
                    // Show "Back to Reading" button
                    const backToReadingContainer = document.getElementById('backToReadingContainer');
                    if (backToReadingContainer) {
                        backToReadingContainer.style.display = 'block';
                    }
                }

                // First, check if post is already in DOM
                const posts = document.querySelectorAll('[data-post-uri]');
                for (const post of posts) {
                    if (post.getAttribute('data-post-uri') === postUri) {
                        post.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        post.style.backgroundColor = '#fff3cd';
                        setTimeout(() => {
                            post.style.backgroundColor = '';
                        }, 2000);
                        return;
                    }
                }

                // If the post is hidden behind the unloaded-posts placeholder, restore chunks
                // (undoing unloadOldPosts()) until it's back in the DOM
                if (this.unloadPlaceholderEl && this.filteredPostsCache) {
                    const idxInFiltered = this.filteredPostsCache.findIndex(item => item.post && item.post.uri === postUri);
                    if (idxInFiltered !== -1 && idxInFiltered < this.renderedWindowStart) {
                        while (this.unloadedChunks.length > 0 && idxInFiltered < this.renderedWindowStart) {
                            this.restoreOldPosts();
                        }
                        const restoredEl = document.querySelector(`[data-post-uri="${CSS.escape(postUri)}"]`);
                        if (restoredEl) {
                            restoredEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            restoredEl.style.backgroundColor = '#fff3cd';
                            setTimeout(() => {
                                restoredEl.style.backgroundColor = '';
                            }, 2000);
                            return;
                        }
                    }
                }

                // Post not in DOM, need to load it
                // Find the post in allPosts
                const postIndex = this.allPosts.findIndex(item => item.post.uri === postUri);
                if (postIndex === -1) {
                    console.warn('Post not found:', postUri);
                    return;
                }

                // Get filtered posts (using same logic as renderPage)
                const startDateInput = document.getElementById('startDateInput').value;
                const startDate = startDateInput ? new Date(startDateInput).toISOString() : null;
                let filteredPosts = this.allPosts.filter(item => {
                    if (startDate && this.getPostDate(item).toISOString() < startDate) {
                        return false;
                    }
                    // Apply mute/block filter if enabled
                    if (this.muteBlockEnabled && this.muteBlockListLoaded) {
                        const authorDid = item.post.author.did;
                        if (this.mutedAccounts.has(authorDid) || this.blockedAccounts.has(authorDid)) {
                            return false;
                        }
                        if (item.reason && item.reason.$type === 'app.bsky.feed.defs#reasonRepost') {
                            if (this.mutedAccounts.has(item.reason.by.did) || this.blockedAccounts.has(item.reason.by.did)) {
                                return false;
                            }
                        }
                    }
                    return true;
                });

                // Find position in filtered posts
                const filteredIndex = filteredPosts.findIndex(item => item.post.uri === postUri);
                if (filteredIndex === -1) {
                    console.warn('Post filtered out:', postUri);
                    return;
                }

                // Set displayedCount to render enough posts to show this one
                this.displayedCount = filteredIndex + 1;

                // Render the posts
                this.renderPage();

                // After rendering, scroll to the post
                setTimeout(() => {
                    const postEl = document.querySelector(`[data-post-uri="${postUri}"]`);
                    if (postEl) {
                        postEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        postEl.style.backgroundColor = '#fff3cd';
                        setTimeout(() => {
                            postEl.style.backgroundColor = '';
                        }, 2000);
                    }
                }, 100);
            }

            restoreLastPosition() {
                // Only restore if position was saved within last 30 minutes
                if (Date.now() - this.lastScrollTimestamp > 30 * 60 * 1000) {
                    console.warn('Saved position too old, not restoring');
                    return;
                }

                window.scrollTo({ top: this.lastScrollPosition, behavior: 'smooth' });
                
                // Hide "Back to Reading" button after use
                const backToReadingContainer = document.getElementById('backToReadingContainer');
                if (backToReadingContainer) {
                    backToReadingContainer.style.display = 'none';
                }
                
                // Reset position saved flag so new searches can save a new position
                this.positionSavedThisSession = false;
            }

            // ========== PROGRESS BAR FUNCTIONALITY ==========
            setupScrollListener() {
                window.addEventListener('scroll', () => {
                    const progressBar = document.getElementById('progressBar');
                    
                    // Get filtered posts (in-range)
                    const startDateInput = document.getElementById('startDateInput').value;
                    const startDate = startDateInput ? new Date(startDateInput).toISOString() : null;
                    const filteredPosts = startDate ? 
                        this.allPosts.filter(item => this.getPostDate(item).toISOString() >= startDate) :
                        this.allPosts;
                    
                    if (filteredPosts.length === 0) {
                        progressBar.style.width = '0%';
                        return;
                    }
                    
                    // Progress = displayed count / total filtered
                    const progress = (this.displayedCount / filteredPosts.length) * 100;
                    progressBar.style.width = Math.min(progress, 100) + '%';
                });
            }

            // ========== THREAD VIEWER FUNCTIONALITY ==========
            setupReplyHoverListener() {
                // Use event delegation on the feed
                document.addEventListener('mouseover', (e) => {
                    const postEl = e.target.closest('.post-is-reply');
                    if (postEl && postEl.getAttribute('data-post-uri')) {
                        const postUri = postEl.getAttribute('data-post-uri');
                        this.showThreadPreview(postUri, postEl);
                    }
                });
            }

            async showThreadPreview(postUri, postEl) {
                // Fetch thread when user hovers over a reply
                if (this.currentThreadUri === postUri) return; // Already showing this thread
                
                this.currentThreadUri = postUri;
                try {
                    const thread = await this.fetchThread(postUri);
                    if (thread) {
                        this.renderThread(thread, postUri);
                        // Show thread tab
                        this.switchTab('thread');
                    }
                } catch (error) {
                    console.error('Error fetching thread:', error);
                }
            }

            async openThreadViewer(postUri) {
                // Open thread viewer for a specific post (called from View Thread button)
                this.currentThreadUri = postUri;
                try {
                    const thread = await this.fetchThread(postUri);
                    if (thread) {
                        this.renderThread(thread, postUri);
                        this.switchTab('thread');
                    } else {
                        alert('Unable to load thread. Please try again.');
                    }
                } catch (error) {
                    console.error('Error opening thread:', error);
                    alert('Error loading thread: ' + error.message);
                }
            }

            async fetchThread(postUri) {
                try {
                    const endpoint = `${API_BASE}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(postUri)}&depth=10&height=10`;
                    const headers = this.authToken ? { 'Authorization': `Bearer ${this.authToken}` } : {};
                    
                    const response = await fetch(endpoint, { headers });
                    if (!response.ok) return null;
                    
                    const data = await response.json();
                    return data.thread;
                } catch (error) {
                    console.error('Error fetching thread:', error);
                    return null;
                }
            }

            buildThreadChain(thread, targetUri) {
                // Build array of posts from root to target
                const chain = [];
                
                let current = thread;
                while (current) {
                    if (current.post) {
                        chain.push(current.post);
                    }
                    if (current.parent) {
                        current = current.parent;
                    } else {
                        break;
                    }
                }
                
                // Reverse to show root first
                chain.reverse();
                
                return chain;
            }

            renderThread(thread, currentPostUri) {
                const threadViewer = document.getElementById('threadViewer');
                const chain = this.buildThreadChain(thread, currentPostUri);
                
                if (chain.length === 0) {
                    threadViewer.innerHTML = '<div class="thread-no-thread">Unable to load thread</div>';
                    return;
                }

                threadViewer.innerHTML = chain.map((post, idx) => {
                    const isCurrent = post.uri === currentPostUri;
                    const author = post.author;
                    const avatarHtml = this.getAvatarHtml(author);
                    
                    const text = post.record.text.substring(0, 120);
                    
                    // Extract images from thread post (check post.embed for API view structure)
                    let mediaHtml = '';
                    
                    if (post.embed && post.embed.$type === 'app.bsky.embed.images#view' && post.embed.images && post.embed.images.length > 0) {
                        const images = post.embed.images.slice(0, 2);
                        mediaHtml = `
                            <div class="thread-post-images">
                                ${images.map(img => `<img src="${this.escapeHtml(img.thumb)}" alt="" class="thread-post-image">`).join('')}
                            </div>
                        `;
                    } else if (post.embed && post.embed.$type === 'app.bsky.embed.recordWithMedia#view' && post.embed.media && post.embed.media.$type === 'app.bsky.embed.images#view' && post.embed.media.images) {
                        const images = post.embed.media.images.slice(0, 2);
                        mediaHtml = `
                            <div class="thread-post-images">
                                ${images.map(img => `<img src="${this.escapeHtml(img.thumb)}" alt="" class="thread-post-image">`).join('')}
                            </div>
                        `;
                    } else if (post.embed && post.embed.$type === 'app.bsky.embed.video#view' && post.embed.thumbnail) {
                        mediaHtml = `
                            <div class="thread-post-images">
                                <img src="${this.escapeHtml(post.embed.thumbnail)}" alt="" class="thread-post-image">
                            </div>
                        `;
                    } else if (post.embed && post.embed.$type === 'app.bsky.embed.external#view' && post.embed.external && post.embed.external.thumb) {
                        mediaHtml = `
                            <div class="thread-post-images">
                                <img src="${this.escapeHtml(post.embed.external.thumb)}" alt="" class="thread-post-image">
                            </div>
                        `;
                    }
                    
                    return `
                        <div class="thread-post${isCurrent ? ' current' : ''}" onclick="app.scrollToPost('${post.uri}')">
                            <div class="thread-post-header">
                                <div class="thread-post-avatar">${avatarHtml}</div>
                                <div>
                                    <div class="thread-post-author">${this.escapeHtml(author.displayName || author.handle)}</div>
                                    <div class="thread-post-handle">@${this.escapeHtml(author.handle)}</div>
                                </div>
                            </div>
                            <div class="thread-post-text">${this.escapeHtml(text)}${text.length === 120 ? '...' : ''}</div>
                            ${mediaHtml}
                        </div>
                        ${idx < chain.length - 1 ? '<div class="thread-connection"></div>' : ''}
                    `;
                }).join('');
            }

            switchTab(tabName) {
                // Hide all tabs
                document.getElementById('searchTab').classList.remove('active');
                document.getElementById('searchTab').style.display = 'none';
                document.getElementById('threadTab').classList.remove('active');
                document.getElementById('threadTab').style.display = 'none';
                document.getElementById('suggestionsTab').classList.remove('active');
                document.getElementById('suggestionsTab').style.display = 'none';

                // Show selected tab
                const tab = document.getElementById(tabName + 'Tab');
                if (tab) {
                    tab.classList.add('active');
                    tab.style.display = 'block';
                }
                
                // Ensure sidebar is open
                const sidebar = document.getElementById('rightSidebar');
                if (!sidebar.classList.contains('open')) {
                    this.toggleRightSidebar();
                }
            }

            computeSuggestions() {
                const resultsEl = document.getElementById('suggestionsResults');
                const btn = document.getElementById('findSuggestionsBtn');

                if (!this.allPosts || this.allPosts.length === 0) {
                    resultsEl.innerHTML = '<p class="search-no-results">Load a feed first, then try again.</p>';
                    return;
                }

                btn.textContent = 'Scanning…';
                btn.disabled = true;

                // Build set of DIDs to exclude from suggestions (followed + own accounts)
                const knownDids = new Set(this.followedAccounts.map(a => a.did));
                for (const slot of this.activeAccounts) {
                    if (this.accounts[slot]) knownDids.add(this.accounts[slot].did);
                }

                // scores: did → { score, contributors (Set of endorser DIDs), profile }
                const scores = new Map();

                const addSignal = (candidate, endorserDid, points) => {
                    if (!candidate || !candidate.did) return;
                    if (knownDids.has(candidate.did)) return;
                    if (!scores.has(candidate.did)) {
                        scores.set(candidate.did, { score: 0, contributors: new Set(), profile: candidate });
                    }
                    const entry = scores.get(candidate.did);
                    entry.score += points;
                    if (endorserDid) entry.contributors.add(endorserDid);
                };

                for (const item of this.allPosts) {
                    const post = item.post;
                    if (!post) continue;
                    const postAuthorDid = post.author?.did;
                    const postAuthorIsKnown = postAuthorDid && knownDids.has(postAuthorDid);

                    // Repost: a follow reposted a non-followed account's post → surface the original author
                    if (item.reason && item.reason.$type === 'app.bsky.feed.defs#reasonRepost') {
                        const reposterDid = item.reason.by?.did;
                        if (reposterDid && knownDids.has(reposterDid)) {
                            addSignal(post.author, reposterDid, 2);
                        }
                    }

                    // Reply: a follow replied to a non-followed account → surface the reply target
                    if (postAuthorIsKnown && item.reply?.parent?.author) {
                        addSignal(item.reply.parent.author, postAuthorDid, 1);
                    }

                    // Quote: a follow quoted a non-followed account → surface the quoted author
                    if (postAuthorIsKnown && post.embed) {
                        const embed = post.embed;
                        if (embed.$type === 'app.bsky.embed.record#view' && embed.record?.author) {
                            addSignal(embed.record.author, postAuthorDid, 3);
                        }
                        if (embed.$type === 'app.bsky.embed.recordWithMedia#view' && embed.record?.record?.author) {
                            addSignal(embed.record.record.author, postAuthorDid, 3);
                        }
                    }
                }

                btn.textContent = 'Find Suggestions';
                btn.disabled = false;

                if (scores.size === 0) {
                    resultsEl.innerHTML = '<p class="search-no-results">No suggestions found in the current feed.</p>';
                    return;
                }

                // Final score = raw score + breadth bonus (distinct endorsers × 2)
                const results = Array.from(scores.values())
                    .map(entry => ({ ...entry, finalScore: entry.score + entry.contributors.size * 2 }))
                    .sort((a, b) => b.finalScore - a.finalScore)
                    .slice(0, 20);

                resultsEl.innerHTML = results.map(entry => {
                    const p = entry.profile;
                    const handle = p.handle || '';
                    const displayName = this.escapeHtml(p.displayName || handle);
                    const avatarHtml = p.avatar
                        ? `<img src="${this.escapeHtml(p.avatar)}" alt="" class="suggestion-avatar">`
                        : `<div class="suggestion-avatar suggestion-avatar-placeholder">${this.escapeHtml((p.displayName || handle).charAt(0).toUpperCase())}</div>`;
                    return `
                        <a class="suggestion-item" href="https://bsky.app/profile/${this.escapeHtml(handle)}" target="_blank" rel="noopener noreferrer">
                            ${avatarHtml}
                            <div class="suggestion-info">
                                <span class="suggestion-display-name">${displayName}</span>
                                <span class="suggestion-handle">@${this.escapeHtml(handle)}</span>
                            </div>
                            <span class="score-pill" title="Engagement score">${entry.finalScore}</span>
                        </a>`;
                }).join('');
            }

            closeThreadViewer() {
                this.currentThreadUri = null;
                document.getElementById('threadViewer').innerHTML = '';
                this.switchTab('search');
            }
        }

        // Initialize app
        const app = new BskyFeedApp();
        app.updatePreloadToggleButton();
        app.setupScrollListener();
        // Disabled: auto-load thread viewer on hover
        // app.setupReplyHoverListener();
        
        // Restore sidebar state
        const sidebarWasOpen = localStorage.getItem('sidebarOpen') === 'true';
        if (sidebarWasOpen) {
            document.getElementById('rightSidebar').classList.add('open');
        }
