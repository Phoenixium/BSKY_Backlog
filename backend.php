<?php
/**
 * Bluesky Feed Viewer - PHP Backend
 * Handles authentication and token refresh for the Bluesky API
 * 
 * Usage: php -S localhost:3000 router.php
 */

// Enable CORS headers
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: authorization, content-type');
header('Access-Control-Max-Age: 86400');
header('Content-Type: application/json');

// Handle preflight requests
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit(json_encode(['status' => 'ok']));
}

// Configuration
$MAX_LOGIN_ATTEMPTS = 5;
$RATE_LIMIT_WINDOW = 900; // 15 minutes
$MAX_INPUT_LENGTH = 256;

// Initialize Memcached for rate limiting
$MEMCACHED = null;
if (extension_loaded('memcached')) {
    try {
        $MEMCACHED = new Memcached();
        $MEMCACHED->addServer('127.0.0.1', 11211);
        // Test connection
        $MEMCACHED->getVersion();
    } catch (Exception $e) {
        $MEMCACHED = null; // Fall back to file-based if connection fails
    }
}

// Fallback rate limit directory for when Memcached is unavailable
$RATE_LIMIT_DIR = sys_get_temp_dir() . '/bsky_rate_limits';
if (!is_dir($RATE_LIMIT_DIR)) {
    @mkdir($RATE_LIMIT_DIR, 0755, true);
}

/**
 * Rate limiting with Memcached fallback to file-based storage
 */
function checkRateLimit($key, $max_attempts, $window_seconds) {
    global $MEMCACHED, $RATE_LIMIT_DIR;
    
    // Try Memcached first
    if ($MEMCACHED !== null) {
        try {
            $attempts = $MEMCACHED->get($key);
            if ($attempts === false) {
                $attempts = 0;
            }
            
            if ($attempts >= $max_attempts) {
                return false; // Rate limited
            }
            
            $MEMCACHED->set($key, $attempts + 1, $window_seconds);
            return true; // OK
        } catch (Exception $e) {
            // Fall through to file-based
        }
    }
    
    // File-based fallback
    $file = $RATE_LIMIT_DIR . '/' . md5($key) . '.json';
    
    $data = [];
    if (file_exists($file)) {
        $content = file_get_contents($file);
        $data = json_decode($content, true) ?: [];
    }
    
    $now = time();
    $data['attempts'] = array_filter($data['attempts'] ?? [], function($t) use ($now, $window_seconds) {
        return ($now - $t) < $window_seconds;
    });
    
    if (count($data['attempts']) >= $max_attempts) {
        return false; // Rate limited
    }
    
    $data['attempts'][] = $now;
    file_put_contents($file, json_encode($data), LOCK_EX);
    
    return true; // OK
}

// Get the request path and body
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$input = file_get_contents('php://input');
$data = json_decode($input, true);

// Route the request - check path OR request body for action type
$isLoginPath = strpos($path, 'login') !== false || (isset($data['identifier']) && isset($data['password']));
$isRefreshPath = strpos($path, 'refresh') !== false || (isset($data['refreshJwt']));

if (($_SERVER['REQUEST_METHOD'] === 'POST') && $isLoginPath) {
    handleLogin($input, $data);
} elseif (($_SERVER['REQUEST_METHOD'] === 'POST') && $isRefreshPath) {
    handleRefresh($input, $data);
} else {
    http_response_code(404);
    echo json_encode(['error' => 'Not found']);
}

/**
 * Handle login requests
 */
function handleLogin($input, $data) {
    try {
        // Configuration
        global $MAX_INPUT_LENGTH, $MAX_LOGIN_ATTEMPTS, $RATE_LIMIT_WINDOW;
        
        if (empty($input) || !is_array($data)) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid request']);
            exit;
        }

        // Validate each field
        if (!isset($data['identifier']) || !is_string($data['identifier'])) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid request']);
            exit;
        }

        if (strlen($data['identifier']) > 256) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid request']);
            exit;
        }
        
        if (!isset($data['password'])) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid request']);
            return;
        }
        
        // Check input length
        if (strlen($data['password']) > $MAX_INPUT_LENGTH) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid request']);
            return;
        }
        
        // Rate limiting
        $ip = $_SERVER['REMOTE_ADDR'];
        $cache_key = "login_attempts:$ip";
        
        if (!checkRateLimit($cache_key, $MAX_LOGIN_ATTEMPTS, $RATE_LIMIT_WINDOW)) {
            http_response_code(429);
            echo json_encode(['error' => 'Too many requests']);
            exit;
        }
        
        // Call Bluesky's authentication API
        $url = 'https://bsky.social/xrpc/com.atproto.server.createSession';
        
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $input);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Content-Type: application/json',
            'User-Agent: Bluesky-Feed-Viewer/1.0'
        ]);
        curl_setopt($ch, CURLOPT_TIMEOUT, 10);
        
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);
        curl_close($ch);
        
        if ($curlError) {
            http_response_code(500);
            echo json_encode(['error' => 'Connection error: ' . $curlError]);
            return;
        }
        
        // Check the HTTP response code
        if ($httpCode !== 200) {
            http_response_code($httpCode);
            echo $response;
            return;
        }
        
        $result = json_decode($response, true);
        
        if ($result) {
            http_response_code(200);
            echo json_encode($result);
        } else {
            http_response_code(500);
            echo json_encode(['error' => 'Authentication failed']);
        }
        
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => $e->getMessage()]);
    }
}

/**
 * Handle token refresh requests
 */
function handleRefresh($input, $data) {
    try {
        if (!$data || !isset($data['refreshJwt'])) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid request']);
            return;
        }
        
        $refreshJwt = $data['refreshJwt'];
        
        // Call Bluesky's refresh API
        $url = 'https://bsky.social/xrpc/com.atproto.server.refreshSession';
        
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, '');
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Authorization: Bearer ' . $refreshJwt
        ]);
        curl_setopt($ch, CURLOPT_TIMEOUT, 10);
        
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);
        curl_close($ch);
        
        if ($curlError) {
            http_response_code(500);
            echo json_encode(['error' => 'Connection error: ' . $curlError]);
            return;
        }
        
        // Check the HTTP response code
        if ($httpCode !== 200) {
            http_response_code($httpCode);
            echo $response;
            return;
        }
        
        $result = json_decode($response, true);
        
        if ($result) {
            http_response_code(200);
            echo json_encode($result);
        } else {
            http_response_code(500);
            echo json_encode(['error' => 'Authentication failed']);
        }
        
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Authentication failed']);
    }
}
?>
