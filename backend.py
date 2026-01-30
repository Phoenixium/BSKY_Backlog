from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import urllib.request
import urllib.error
from urllib.parse import urlparse
from datetime import datetime

def get_timestamp():
    """Get formatted timestamp for logging"""
    return datetime.now().strftime('%H:%M:%S.%f')[:-3]

class CORSRequestHandler(BaseHTTPRequestHandler):
    
    def do_OPTIONS(self):
        """Handle CORS preflight requests"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'authorization, content-type')
        self.send_header('Access-Control-Max-Age', '86400')  # Cache preflight for 24 hours
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        """Handle POST requests"""
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        
        # Parse the path
        parsed_path = urlparse(self.path)
        path = parsed_path.path
        
        if path == '/api/login':
            self.handle_login(body)
        elif path == '/api/refresh-token':
            self.handle_refresh(body)
        else:
            self.send_response(404)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'Not found'}).encode('utf-8'))

    def handle_login(self, body):
        """Handle login requests"""
        try:
            data = json.loads(body)
            ts = get_timestamp()
            print(f"[{ts}] 📨 Login attempt for: {data.get('identifier')}")
            
            # Forward to Bluesky API
            req = urllib.request.Request(
                'https://bsky.social/xrpc/com.atproto.server.createSession',
                data=json.dumps(data).encode('utf-8'),
                headers={
                    'Content-Type': 'application/json',
                    'User-Agent': 'Bluesky-Feed-Viewer/1.0'
                }
            )
            print(f"🔗 Sending POST to: {req.full_url}")
            print(f"📤 Request data: {json.dumps(data)}")
            
            try:
                with urllib.request.urlopen(req, timeout=10) as response:
                    result = json.loads(response.read())
                    ts = get_timestamp()
                    print(f"[{ts}] ✅ Login successful for: {result.get('handle')}")
                    
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(json.dumps(result).encode('utf-8'))
                    
            except urllib.error.HTTPError as e:
                # Read the error response from Bluesky
                ts = get_timestamp()
                try:
                    error_body = e.read().decode('utf-8')
                    error_data = json.loads(error_body)
                    print(f"[{ts}] ❌ Bluesky returned error {e.code}: {error_data}")
                except:
                    error_data = {'error': f'HTTP {e.code}: {e.reason}', 'reason': e.reason}
                    print(f"[{ts}] ❌ HTTP Error {e.code}: {e.reason}")
                
                self.send_response(e.code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(error_data).encode('utf-8'))
            
        except Exception as e:
            error_response = {'error': str(e)}
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(error_response).encode('utf-8'))

    def handle_refresh(self, body):
        """Handle token refresh requests"""
        try:
            data = json.loads(body)
            refresh_jwt = data.get('refreshJwt')
            ts = get_timestamp()
            
            if not refresh_jwt:
                print(f"[{ts}] ⚠️ Refresh attempt without token")
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': 'No refresh token provided'}).encode('utf-8'))
                return
            
            print(f"[{ts}] 🔄 Refreshing token...")
            
            req = urllib.request.Request(
                'https://bsky.social/xrpc/com.atproto.server.refreshSession',
                data=b'',
                headers={'Authorization': f'Bearer {refresh_jwt}'}
            )
            
            try:
                with urllib.request.urlopen(req, timeout=10) as response:
                    result = json.loads(response.read())
                    ts = get_timestamp()
                    print(f"[{ts}] ✅ Token refreshed successfully")
                    
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(json.dumps(result).encode('utf-8'))
                    
            except urllib.error.HTTPError as e:
                ts = get_timestamp()
                try:
                    error_body = e.read().decode('utf-8')
                    error_data = json.loads(error_body)
                    print(f"[{ts}] ❌ Refresh failed {e.code}: {error_data}")
                except:
                    error_data = {'error': f'HTTP {e.code}: {e.reason}'}
                    print(f"[{ts}] ❌ Refresh failed {e.code}: {e.reason}")
                
                self.send_response(e.code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(error_data).encode('utf-8'))
                
        except Exception as e:
            error_response = {'error': str(e)}
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(error_response).encode('utf-8'))

    def log_message(self, format, *args):
        """Suppress default logging"""
        print(f"[{self.client_address[0]}] {format % args}")

if __name__ == '__main__':
    server = HTTPServer(('localhost', 3000), CORSRequestHandler)
    print('✅ Backend server running on http://localhost:3000')
    print('📝 Make sure to also run: python -m http.server 8000')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n❌ Server stopped')
        server.server_close()