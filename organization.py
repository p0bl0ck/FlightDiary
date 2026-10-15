"""Collection and tag operations on the route store; caller owns locking/saving."""
from uuid import uuid4


class InvalidOrganization(ValueError):
    pass


def route_key(route):
    return ':'.join([route['origin'], route['destination'], route.get('airline') or ''])


def snapshot(data):
    return {key: data.get(key, default) for key, default in
            (('collections', []), ('tags', []), ('route_tags', {}))}


def change(data, method, path, payload):
    if not isinstance(payload, dict):
        raise InvalidOrganization('Expected a JSON object.')
    for key, value in snapshot(data).items():
        data.setdefault(key, value)
    route_ids = {route_key(route) for route in data['routes']}
    tag_ids = {tag['id'] for tag in data['tags']}

    def references(value, allowed, label):
        if not isinstance(value, list) or any(not isinstance(item, str) or item not in allowed for item in value):
            raise InvalidOrganization(f'Unknown or invalid {label}.')
        return list(dict.fromkeys(value))

    if path == '/api/route-tags' and method == 'PUT':
        if not {'route', 'tag_ids'} <= set(payload) or set(payload) - {'route', 'tag_ids', 'collection_ids'} or not isinstance(payload['route'], str) or payload['route'] not in route_ids:
            raise InvalidOrganization('Provide an existing route and tag_ids.')
        if 'collection_ids' in payload:
            chosen = references(payload['collection_ids'], {item['id'] for item in data['collections']}, 'collection IDs')
            for collection in data['collections']:
                collection['routes'] = [key for key in collection['routes'] if key != payload['route']]
                if collection['id'] in chosen:
                    collection['routes'].append(payload['route'])
        data['route_tags'][payload['route']] = references(payload['tag_ids'], tag_ids, 'tag IDs')
        return 200, snapshot(data)
    parts = path.strip('/').split('/')
    if len(parts) not in (2, 3) or parts[0] != 'api' or parts[1] not in ('tags', 'collections'):
        return 404, {'error': 'Not found.'}
    kind = parts[1]
    items = data[kind]
    creating = method == 'POST' and len(parts) == 2
    if not creating and (len(parts) != 3 or method not in ('PATCH', 'DELETE')):
        return 405, {'error': 'Method not allowed.'}
    item = None if creating else next((item for item in items if item['id'] == parts[2]), None)
    if not creating and item is None:
        return 404, {'error': 'Not found.'}
    if method == 'DELETE':
        items.remove(item)
        if kind == 'tags':
            for collection in data['collections']:
                collection['tag_ids'] = [tag for tag in collection['tag_ids'] if tag != item['id']]
            for key, tags in data['route_tags'].items():
                data['route_tags'][key] = [tag for tag in tags if tag != item['id']]
        return 200, snapshot(data)
    allowed = {'name'} if kind == 'tags' else {'name', 'routes', 'tag_ids'}
    if not payload or set(payload) - allowed or (creating and 'name' not in payload):
        raise InvalidOrganization('Provide a name and only supported fields.')
    updated = dict(item) if item else {'id': uuid4().hex}
    if kind == 'collections' and creating:
        updated.update(routes=[], tag_ids=[])
    if 'name' in payload:
        name = payload['name']
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100:
            raise InvalidOrganization('Name must contain 1–100 characters.')
        name = name.strip()
        if any(other['id'] != updated['id'] and other['name'].casefold() == name.casefold() for other in items):
            return 409, {'error': 'That name already exists.'}
        updated['name'] = name
    if 'routes' in payload:
        updated['routes'] = references(payload['routes'], route_ids, 'routes')
    if 'tag_ids' in payload:
        updated['tag_ids'] = references(payload['tag_ids'], tag_ids, 'tag IDs')
    if item:
        items[items.index(item)] = updated
    else:
        items.append(updated)
    return (201 if creating else 200), snapshot(data)
