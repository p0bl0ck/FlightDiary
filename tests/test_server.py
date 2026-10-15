import json
import threading
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import server


class Upstream(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({'path': self.path, 'auth': self.headers.get('Authorization')}).encode())

    def log_message(self, *args):
        pass


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        for instance in (cls.app, cls.upstream):
            threading.Thread(target=instance.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.app.server_port}'

    @classmethod
    def tearDownClass(cls):
        for instance in (cls.app, cls.upstream):
            instance.shutdown()
            instance.server_close()

    def request(self, path, payload=None, headers=None, method=None):
        request = urllib.request.Request(self.url + path, data=None if payload is None else json.dumps(payload).encode(), headers={'Content-Type': 'application/json', **(headers or {})}, method=method)
        try:
            response = urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.read()

    def test_health_and_frontend(self):
        self.assertEqual(json.loads(self.request('/api/health')[1])['status'], 'ok')
        for path in ('/', '/app.js', '/map.js', '/organization.js', '/style.css'):
            self.assertEqual(self.request(path)[0], 200)
        self.assertEqual(self.request('/../server.py')[0], 404)

    def test_map_data(self):
        status, body = self.request('/api/airports')
        self.assertEqual(status, 200)
        airports = json.loads(body)
        self.assertEqual(airports['type'], 'FeatureCollection')
        ids = set()
        for feature in airports['features']:
            self.assertEqual(feature['geometry']['type'], 'Point')
            lon, lat = feature['geometry']['coordinates']
            self.assertTrue(-180 <= lon <= 180 and -90 <= lat <= 90)
            self.assertEqual(feature['id'], feature['properties']['iata'])
            self.assertNotIn(feature['id'], ids)
            ids.add(feature['id'])
        self.assertTrue(ids)
        status, body = self.request('/api/airlines')
        self.assertEqual(status, 200)
        airlines = json.loads(body)['airlines']
        self.assertTrue(airlines)
        for airline in airlines:
            self.assertEqual(set(airline), {'iata', 'name', 'country'})
        with patch.object(server.Path, 'read_text', side_effect=OSError):
            self.assertEqual(self.request('/api/airports')[0], 500)
        self.assertEqual(self.request('/data/airports.json')[0], 404)

    def test_routes(self):
        status, body = self.request('/api/routes')
        self.assertEqual(status, 200)
        self.assertIsInstance(json.loads(body)['routes'], list)
        sample = {'routes': [{'origin': 'ZRH', 'destination': 'LHR', 'airline': 'LX'}]}
        with patch.object(server.Path, 'read_text', return_value=json.dumps(sample)):
            status, body = self.request('/api/routes')
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), sample)
        with patch.object(server.Path, 'read_text', side_effect=OSError):
            self.assertEqual(self.request('/api/routes')[0], 500)
        self.assertEqual(self.request('/data/flightdiary.json')[0], 404)

    def test_route_mutations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / 'data'
            data.mkdir()
            for name in ('airports.json', 'airlines.json'):
                (data / name).write_bytes((server.ROOT / 'data' / name).read_bytes())
            path = data / 'flightdiary.json'
            path.write_text('{"routes": []}')
            route = {'origin': 'ZRH', 'destination': 'LHR', 'airline': 'LX'}
            with patch.object(server, 'ROOT', root):
                def mutate(payload, method='POST', headers=None):
                    return self.request('/api/routes', payload, headers, method)[0]
                self.assertEqual(mutate({**route, 'origin': ' zrh '}), 201)
                self.assertEqual(json.loads(path.read_text())['routes'], [route])
                self.assertEqual(mutate(route), 409)
                unassigned = {'origin': 'ZRH', 'destination': 'LHR'}
                self.assertEqual(mutate(unassigned), 201)
                self.assertEqual(mutate({**unassigned, 'airline': None}), 409)
                self.assertEqual(mutate({**unassigned, 'airline': '  '}), 409)
                self.assertEqual(mutate({**unassigned, 'airline': 123}), 400)
                saved = json.loads(path.read_text())['routes']
                self.assertIn({**unassigned, 'airline': ''}, saved)
                self.assertIn(route, saved)
                status, raw = self.request('/api/collections', {'name': 'Unassigned', 'routes': ['ZRH:LHR:']})
                self.assertEqual(status, 201, raw)
                self.assertEqual(mutate(unassigned, 'DELETE'), 200)
                self.assertEqual(mutate(unassigned, 'DELETE'), 404)
                self.assertEqual(json.loads(path.read_text())['collections'][0]['routes'], [])
                self.assertEqual(json.loads(path.read_text())['routes'], [route])

                status, raw = self.request('/api/tags', {'name': 'Trip'})
                self.assertEqual(status, 201)
                tag_id = json.loads(raw)['tags'][0]['id']
                collection_id = json.loads(path.read_text())['collections'][0]['id']
                assigned = {**unassigned, 'tag_ids': [tag_id], 'collection_ids': [collection_id]}
                before = path.read_bytes()
                self.assertEqual(mutate({**assigned, 'tag_ids': ['missing']}), 400)
                self.assertEqual(mutate({**assigned, 'collection_ids': ['missing']}), 400)
                self.assertEqual(path.read_bytes(), before)
                self.assertEqual(mutate(assigned), 201)
                saved = json.loads(path.read_text())
                self.assertEqual(saved['route_tags']['ZRH:LHR:'], [tag_id])
                self.assertEqual(saved['collections'][0]['routes'], ['ZRH:LHR:'])
                before = path.read_bytes()
                self.assertEqual(mutate(assigned), 409)
                self.assertEqual(path.read_bytes(), before)
                self.assertEqual(mutate(unassigned, 'DELETE'), 200)
                for invalid in ({}, [], {**route, 'origin': 'XXX'},
                                {**route, 'airline': 'ZZ'}, {**route, 'origin': 'LHR'},
                                {**route, 'origin': 123}, {**route, 'extra': True}):
                    self.assertEqual(mutate(invalid), 400)
                for method in ('POST', 'DELETE'):
                    self.assertEqual(mutate(route, method, {'Origin': 'https://evil.example'}), 403)
                    self.assertEqual(mutate(route, method, {'Content-Type': 'text/plain'}), 415)
                reverse = {**route, 'origin': 'LHR', 'destination': 'ZRH'}
                with ThreadPoolExecutor(max_workers=2) as pool:
                    statuses = list(pool.map(mutate, [reverse, reverse]))
                self.assertEqual(sorted(statuses), [201, 409])
                self.assertEqual(len(json.loads(path.read_text())['routes']), 2)
                before = path.read_bytes()
                with patch.object(server.os, 'replace', side_effect=OSError):
                    self.assertEqual(mutate(route, 'DELETE'), 500)
                self.assertEqual(path.read_bytes(), before)
                self.assertEqual(sorted(p.name for p in data.iterdir()),
                                 ['airlines.json', 'airports.json', 'flightdiary.json'])
                self.assertEqual(mutate(route, 'DELETE'), 200)
                self.assertEqual(mutate(route, 'DELETE'), 404)
                self.assertEqual(json.loads(self.request('/api/routes')[1])['routes'], [reverse])
                path.write_text('broken JSON')
                self.assertEqual(mutate(route), 500)
                self.assertEqual(path.read_text(), 'broken JSON')

    def test_collections_and_tags(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            route = {'origin': 'ZRH', 'destination': 'LHR', 'airline': 'LX'}
            path = root / 'data' / 'flightdiary.json'
            path.write_text(json.dumps({'routes': [route]}))
            with patch.object(server, 'ROOT', root):
                def call(url, body=None, method=None, expected=200):
                    status, raw = self.request(url, body, method=method)
                    self.assertEqual(status, expected, raw)
                    return json.loads(raw)
                self.assertEqual(call('/api/organization'), {'collections': [], 'tags': [], 'route_tags': {}})
                result = call('/api/tags', {'name': ' Holiday '}, 'POST', 201)
                tag = result['tags'][0]['id']
                self.assertEqual(call('/api/tags')['tags'], result['tags'])
                self.assertEqual(call('/api/collections')['collections'], [])
                call('/api/tags', {'name': 'holiday'}, 'POST', 409)
                call('/api/tags', {'name': '  '}, 'POST', 400)
                call('/api/tags', {'name': 123}, 'POST', 400)
                result = call('/api/collections', {'name': 'Asia', 'routes': ['ZRH:LHR:LX'], 'tag_ids': [tag]}, 'POST', 201)
                collection = result['collections'][0]['id']
                self.assertEqual(result['route_tags'], {})
                result = call('/api/collections', {'name': 'Wishlist'}, 'POST', 201)
                other = result['collections'][1]['id']
                result = call('/api/route-tags', {'route': 'ZRH:LHR:LX', 'tag_ids': [tag, tag], 'collection_ids': [collection, other]}, 'PUT')
                self.assertEqual(result['route_tags']['ZRH:LHR:LX'], [tag])
                self.assertTrue(all(c['routes'] == ['ZRH:LHR:LX'] for c in result['collections']))
                call('/api/collections/' + collection, {'name': 'Summer'}, 'PATCH')
                call('/api/tags/' + tag, {'name': 'Vacation'}, 'PATCH')
                before = path.read_bytes()
                call('/wrong/tags/' + tag, {'name': 'Wrong'}, 'PATCH', 404)
                call('/api/route-tags', {'route': 'ZRH:LHR:LX', 'tag_ids': ['missing'], 'collection_ids': []}, 'PUT', 400)
                call('/api/collections/' + collection, {'routes': ['missing']}, 'PATCH', 400)
                call('/api/collections/' + collection, {'tag_ids': [None]}, 'PATCH', 400)
                self.assertEqual(path.read_bytes(), before)
                with patch.object(server.os, 'replace', side_effect=OSError):
                    call('/api/tags/' + tag, {'name': 'Lost'}, 'PATCH', 500)
                self.assertEqual(path.read_bytes(), before)
                for method in ('POST', 'PATCH', 'PUT', 'DELETE'):
                    self.assertEqual(self.request('/api/tags', {}, {'Origin': 'https://evil.example'}, method)[0], 403)
                call('/api/collections/' + other, {}, 'DELETE')
                self.assertEqual(json.loads(path.read_text())['routes'], [route])
                result = call('/api/tags/' + tag, {}, 'DELETE')
                self.assertEqual(result['collections'][0]['tag_ids'], [])
                self.assertEqual(result['route_tags']['ZRH:LHR:LX'], [])
                call('/api/tags/' + tag, {}, 'DELETE', 404)
                call('/api/routes', route, 'DELETE')
                result = call('/api/organization')
                self.assertEqual(result['collections'][0]['routes'], [])
                self.assertEqual(result['route_tags'], {})
                self.assertEqual(json.loads(path.read_text())['collections'], result['collections'])

    def test_local_map_dependencies(self):
        for name in ('maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css', 'LICENSE.txt'):
            with urllib.request.urlopen(self.url + '/vendor/maplibre-gl/' + name) as response:
                self.assertEqual(response.status, 200)
                self.assertTrue(response.read())
                if name.endswith('.mjs'):
                    self.assertEqual(response.headers.get_content_type(), 'text/javascript')
                self.assertIn("worker-src 'self'", response.headers['Content-Security-Policy'])
        self.assertEqual(self.request('/vendor/maplibre-gl/../../server.py')[0], 404)

    def test_airline_icons(self):
        airlines = json.loads((server.ROOT / 'data' / 'airlines.json').read_text())['airlines']
        for airline in airlines:
            with self.subTest(code=airline['iata']):
                filename = airline['iata'] + '.png'
                with urllib.request.urlopen(self.url + '/airlines/' + filename) as response:
                    image = response.read()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers['Content-Type'], 'image/png')
                    self.assertEqual(image, (server.ROOT / 'static' / 'airlines' / filename).read_bytes())
                    self.assertTrue(image.startswith(b'\x89PNG\r\n\x1a\n'))
                    self.assertEqual(int.from_bytes(image[16:20], 'big'), 70)
                    self.assertEqual(int.from_bytes(image[20:24], 'big'), 70)
        for path in ('ZZ.png', 'lx.png', 'LXX.png', 'L.png', 'LX.svg',
                     '../server.py', '%2e%2e/server.py', 'LX.png/../../server.py'):
            with self.subTest(path=path):
                self.assertEqual(self.request('/airlines/' + path)[0], 404)

        # Alphanumeric codes are supported, including future locally added logos.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'static' / 'airlines').mkdir(parents=True)
            sample = (server.ROOT / 'static' / 'airlines' / 'LX.png').read_bytes()
            (root / 'static' / 'airlines' / 'U2.png').write_bytes(sample)
            with patch.object(server, 'ROOT', root):
                self.assertEqual(self.request('/airlines/U2.png'), (200, sample))

    def test_echo_and_validation(self):
        self.assertEqual(json.loads(self.request('/api/echo', {'message': 'hello'})[1])['received'], {'message': 'hello'})
        self.assertEqual(self.request('/api/echo', [1])[0], 400)
        self.assertEqual(self.request('/api/echo', {'value': 'x' * 65536})[0], 413)

    def test_origin_and_host(self):
        self.assertEqual(self.request('/api/echo', {}, {'Origin': 'https://untrusted.example'})[0], 403)
        self.assertEqual(self.request('/api/health', headers={'Host': 'untrusted.example'})[0], 403)

    def test_outbound_and_secret_handling(self):
        config = {'demo': {'base_url': f'http://127.0.0.1:{self.upstream.server_port}/v1/', 'token_env': 'TEST_API_TOKEN'}}
        with patch.object(server, 'connections', return_value=config), patch.dict(server.os.environ, {'TEST_API_TOKEN': 'test-secret'}):
            status, body = self.request('/api/request', {'connection': 'demo', 'path': 'flights?q=1'})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)['data'], {'path': '/v1/flights?q=1', 'auth': 'Bearer test-secret'})
            self.assertNotIn(b'test-secret', self.request('/api/connections')[1])
            for path in ('https://evil.example', '//evil.example', '../private', '%2e%2e/private'):
                self.assertEqual(self.request('/api/request', {'connection': 'demo', 'path': path})[0], 400)
            self.assertEqual(self.request('/api/request', {'connection': 'missing'})[0], 404)


if __name__ == '__main__':
    unittest.main()
