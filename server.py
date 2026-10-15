"""FlightDiary local application server. Python 3.10+, no dependencies."""
import json
import organization
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
MAX_BODY = 64 * 1024
MAX_RESPONSE = 2 * 1024 * 1024
STARTED = time.monotonic()
ROUTES_LOCK = threading.Lock()


def save_route_data(path, data):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as output:
            temporary = output.name
            json.dump(data, output, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def change_route(route, delete=False, associations=None):
    """Serialize updates and replace the JSON file atomically."""
    with ROUTES_LOCK:
        path = ROOT / 'data' / 'flightdiary.json'
        data = json.loads(path.read_text())
        routes = data['routes']
        if not isinstance(routes, list) or not all(isinstance(item, dict) for item in routes):
            raise ValueError('Invalid routes file.')
        matches = [item for item in routes if all((item.get(key) or '') == value for key, value in route.items())]
        if delete:
            if not matches:
                return 404, {'error': 'Route not found.'}
            data['routes'] = [item for item in routes if item not in matches]
        else:
            airports = json.loads((ROOT / 'data' / 'airports.json').read_text())
            airlines = json.loads((ROOT / 'data' / 'airlines.json').read_text())
            codes = {item['properties']['iata'] for item in airports['features']}
            if route['origin'] not in codes or route['destination'] not in codes:
                return 400, {'error': 'Unknown airport code.'}
            if route['airline'] and route['airline'] not in {item['iata'] for item in airlines['airlines']}:
                return 400, {'error': 'Unknown airline code.'}
            if matches:
                return 409, {'error': 'Route already exists.'}
            routes.append(route)
            if associations is not None:
                organization.change(data, 'PUT', '/api/route-tags', {
                    'route': organization.route_key(route), **associations
                })
        if delete:
            key = organization.route_key(route)
            for collection in data.get('collections', []):
                collection['routes'] = [value for value in collection['routes'] if value != key]
            data.get('route_tags', {}).pop(key, None)
        save_route_data(path, data)
        return (200 if delete else 201), {'route': route, 'organization': organization.snapshot(data)}


def connections():
    """Load named, trusted upstreams; secrets are resolved only on the server."""
    path = Path(os.environ.get('CONNECTIONS_FILE', ROOT / 'connections.json'))
    return json.loads(path.read_text()) if path.exists() else {}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def external_request(config, path):
    base = config['base_url'].rstrip('/') + '/'
    parts = urllib.parse.urlsplit(base)
    relative = urllib.parse.urlsplit(path)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        raise ValueError('Connection requires a valid HTTP(S) base URL without credentials.')
    if relative.scheme or relative.netloc or path.startswith('/') or '\\' in path or '..' in urllib.parse.unquote(relative.path).split('/'):
        raise ValueError('Use a relative path within the configured connection.')
    headers = {'Accept': 'application/json', 'User-Agent': 'FlightDiary-Local/1.0'}
    if config.get('token_env'):
        token = os.environ.get(config['token_env'])
        if not token:
            raise ValueError('The API token environment variable is not set.')
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(base + path, headers=headers)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        response = opener.open(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise ValueError('Upstream response exceeds 2 MB.')
        content = raw.decode('utf-8', errors='replace')
        try:
            content = json.loads(content)
        except json.JSONDecodeError:
            pass
        return {'status': response.code, 'data': content}


class Handler(BaseHTTPRequestHandler):
    def send(self, status, data, content_type='application/json; charset=utf-8'):
        body = json.dumps(data).encode() if content_type.startswith('application/json') else data
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://demotiles.maplibre.org; img-src 'self' data: blob:; worker-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def trusted_request(self):
        port = self.server.server_port
        allowed = {f'localhost:{port}', f'127.0.0.1:{port}'}
        if self.headers.get('Host') not in allowed:
            self.send(403, {'error': 'Only localhost connections are accepted.'})
            return False
        origin = self.headers.get('Origin')
        if origin and origin not in {f'http://{host}' for host in allowed}:
            self.send(403, {'error': 'Cross-origin requests are not accepted.'})
            return False
        return True

    def do_GET(self):
        if not self.trusted_request():
            return
        path = urllib.parse.urlsplit(self.path).path
        if re.fullmatch(r'/airlines/[A-Z0-9]{2}\.png', path):
            try:
                image = (ROOT / 'static' / 'airlines' / path.rsplit('/', 1)[1]).read_bytes()
            except FileNotFoundError:
                return self.send(404, {'error': 'Not found.'})
            return self.send(200, image, 'image/png')
        if path == '/api/health':
            return self.send(200, {'status': 'ok', 'service': 'FlightDiary brain', 'uptime_seconds': round(time.monotonic() - STARTED)})
        if path in ('/api/organization', '/api/collections', '/api/tags'):
            try:
                data = json.loads((ROOT / 'data' / 'flightdiary.json').read_text())
                result = organization.snapshot(data)
                if path != '/api/organization':
                    key = path.removeprefix('/api/')
                    result = {key: result[key]}
                return self.send(200, result)
            except (OSError, ValueError, TypeError):
                return self.send(500, {'error': 'Organization data unavailable.'})
        if path == '/api/connections':
            try:
                return self.send(200, {'connections': [{'name': name, 'base_url': value['base_url']} for name, value in connections().items()]})
            except (ValueError, OSError, KeyError, TypeError):
                return self.send(500, {'error': 'Invalid connections configuration.'})
        if path in ('/api/airports', '/api/airlines', '/api/routes'):
            try:
                filename = 'flightdiary.json' if path == '/api/routes' else path.removeprefix('/api/') + '.json'
                data = json.loads((ROOT / 'data' / filename).read_text())
                return self.send(200, data)
            except (OSError, ValueError):
                return self.send(500, {'error': 'Map sample data is unavailable or invalid.'})
        files = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/map.js': ('map.js', 'text/javascript'), '/organization.js': ('organization.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
        for name in ('maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css', 'LICENSE.txt'):
            kind = 'text/javascript' if name.endswith('.mjs') else 'text/css' if name.endswith('.css') else 'text/plain'
            files['/vendor/maplibre-gl/' + name] = ('vendor/maplibre-gl/' + name, kind)
        if path in files:
            name, kind = files[path]
            return self.send(200, (ROOT / 'static' / name).read_bytes(), kind + '; charset=utf-8')
        self.send(404, {'error': 'Not found.'})

    def do_POST(self):
        if self.path.startswith(('/api/collections', '/api/tags')):
            return self.mutate_organization()
        if self.path == '/api/routes':
            return self.mutate_route()
        if not self.trusted_request():
            return
        if self.path not in ('/api/echo', '/api/request'):
            return self.send(404, {'error': 'Not found.'})
        if self.headers.get_content_type() != 'application/json':
            return self.send(415, {'error': 'Use application/json.'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 1 or size > MAX_BODY:
                return self.send(413, {'error': 'Request must contain 1–65536 bytes.'})
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError('Request must be a JSON object.')
            if self.path == '/api/echo':
                return self.send(200, {'received': payload, 'processed_by': 'Python server'})
            name, path = payload.get('connection'), payload.get('path', '')
            if not isinstance(name, str) or not isinstance(path, str):
                raise ValueError('Connection and path must be strings.')
            config = connections().get(name)
            if config is None:
                return self.send(404, {'error': 'Unknown connection. Configure connections.json first.'})
            self.send(200, external_request(config, path))
        except (ValueError, UnicodeError) as error:
            self.send(400, {'error': str(error)})
        except (urllib.error.URLError, TimeoutError, OSError):
            self.send(502, {'error': 'Could not reach the upstream service.'})
        except (KeyError, TypeError):
            self.send(500, {'error': 'Invalid connections configuration.'})

    def do_DELETE(self):
        if self.path.startswith(('/api/collections', '/api/tags')):
            return self.mutate_organization()
        if self.path == '/api/routes':
            return self.mutate_route(delete=True)
        if self.trusted_request():
            self.send(404, {'error': 'Not found.'})

    def do_PATCH(self):
        self.mutate_organization()

    def do_PUT(self):
        self.mutate_organization()

    def mutate_organization(self):
        if not self.trusted_request():
            return
        if self.headers.get_content_type() != 'application/json':
            return self.send(415, {'error': 'Use application/json.'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 1 or size > MAX_BODY:
                return self.send(413, {'error': 'Request must contain 1–65536 bytes.'})
            payload = json.loads(self.rfile.read(size))
        except (ValueError, UnicodeError):
            return self.send(400, {'error': 'Invalid JSON body.'})
        try:
            with ROUTES_LOCK:
                path = ROOT / 'data' / 'flightdiary.json'
                data = json.loads(path.read_text())
                status, result = organization.change(data, self.command, self.path, payload)
                if status < 300:
                    save_route_data(path, data)
        except organization.InvalidOrganization as error:
            return self.send(400, {'error': str(error)})
        except (OSError, ValueError, TypeError, KeyError):
            return self.send(500, {'error': 'Could not update organization data.'})
        self.send(status, result)

    def mutate_route(self, delete=False):
        if not self.trusted_request():
            return
        if self.headers.get_content_type() != 'application/json':
            return self.send(415, {'error': 'Use application/json.'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 1 or size > MAX_BODY:
                return self.send(413, {'error': 'Request must contain 1–65536 bytes.'})
            payload = json.loads(self.rfile.read(size))
            fields = {'origin': 3, 'destination': 3, 'airline': 2}
            allowed = set(fields) | (set() if delete else {'tag_ids', 'collection_ids'})
            if not isinstance(payload, dict) or not {'origin', 'destination'} <= set(payload) or set(payload) - allowed:
                raise ValueError('Provide origin, destination, and an optional airline.')
            route = {}
            for field, length in fields.items():
                value = payload.get(field)
                if field == 'airline' and (value is None or isinstance(value, str) and not value.strip()):
                    route[field] = ''
                    continue
                if not isinstance(value, str):
                    raise ValueError(f'{field} must be an IATA code.')
                value = value.strip().upper()
                if len(value) != length or not value.isascii() or not value.isalnum():
                    raise ValueError(f'{field} must be a {length}-character IATA code.')
                route[field] = value
            if route['origin'] == route['destination']:
                raise ValueError('Origin and destination must be different.')
        except (ValueError, UnicodeError) as error:
            return self.send(400, {'error': str(error)})
        try:
            associations = None if delete else {key: payload.get(key, []) for key in ('tag_ids', 'collection_ids')}
            status, result = change_route(route, delete, associations)
        except organization.InvalidOrganization as error:
            return self.send(400, {'error': str(error)})
        except (OSError, ValueError, KeyError, TypeError):
            return self.send(500, {'error': 'Could not update route data.'})
        self.send(status, result)

    def setup(self):
        super().setup()
        self.connection.settimeout(20)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8000'))
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'FlightDiary running at http://localhost:{port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
