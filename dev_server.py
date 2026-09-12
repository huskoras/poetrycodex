# Local development server for Poetry Codex.
# Multi-threaded + no-cache so multiple browser tabs work and changes always show.
import http.server, os

PORT = 8777
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

# ThreadingHTTPServer handles many connections at once (fixes hanging tabs).
httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
httpd.daemon_threads = True
print(f"Poetry Codex dev server on http://localhost:{PORT}")
httpd.serve_forever()
