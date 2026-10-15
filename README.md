# FlightDiary local app

A browser console backed by a small, dependency-free Python server. Python serves the frontend, handles local JSON requests, and makes outbound API calls. Requires Python 3.10 or newer.

## Run

```sh
python3 server.py
```

Open http://localhost:8000. Stop with Ctrl+C. Set `PORT=8080` to change the port. The server binds only to `127.0.0.1`.

## Connect an API or local service

Edit `connections.json` using `connections.example.json` as a guide:

```json
{
  "my-api": {
    "base_url": "https://your-api-host.example/v1/",
    "token_env": "FLIGHTDIARY_API_TOKEN"
  },
  "local-service": {
    "base_url": "http://127.0.0.1:9000/"
  }
}
```

Replace the example URL with your real service. Omit `token_env` for APIs without authentication. For bearer authentication, set the named environment variable before launching Python. `.env` files are not automatically loaded. Never put secrets in frontend files. Refresh the page after editing connections; no server restart is needed. `CONNECTIONS_FILE` optionally selects another JSON configuration file.

Choose a connection and enter a relative path such as `flights?limit=10`. This initial adapter supports GET requests, a 15-second upstream timeout, a 2 MB response limit, and JSON or text responses. Redirects are returned without being followed. Add provider-specific methods and authentication in `external_request` as integrations are defined.

## Local API

- `GET /api/health` — server status and uptime.
- `GET /api/connections` — configured names and base URLs, without tokens.
- `POST /api/echo` — accepts a JSON object and returns it to confirm connectivity.
- `POST /api/request` — accepts `{"connection":"my-api","path":"flights?limit=10"}` and returns the upstream HTTP `status` and `data`. Upstream non-2xx responses retain their status in the envelope; connection failures return local HTTP 502.

```sh
curl -H 'Content-Type: application/json' -d '{"message":"hello"}' http://localhost:8000/api/echo
```

External requests are outbound calls from Python. This app does not expose an inbound public API. It accepts localhost hosts and same-origin browser requests only; command-line local clients work without an Origin header. Configuration is trusted and may name other local services. This is a local development server, not a public production deployment. No flight records or persistence have been added yet.

## Verify

```sh
python3 -m unittest discover -s tests -v
```

## Sample map

The airport explorer uses [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) 6.10.0, with pinned modules, worker, CSS, and license served locally from `static/vendor/maplibre-gl/`, with the MapLibre demonstration basemap. No API key or Node build step is needed. Internet access for the basemap and a WebGL-capable browser are required. The worker loads directly from localhost without a Blob bootstrap. Restart the Python server after updating routes or the Content Security Policy, then reload the page. Demo tiles are intended for development; choose a suitable tile provider before production use and update the server Content Security Policy for its hosts.

- `GET /api/airports` serves `data/airports.json`, a GeoJSON FeatureCollection of Point features. Coordinates are **[longitude, latitude]** in decimal degrees. Each airport has an IATA feature ID and `iata`, `name`, `city`, and ISO two-letter `country` properties.

- `GET /api/airlines` serves `data/airlines.json`, an object containing an `airlines` array. Entries have `iata`, `name`, and `country`. Airline data remains available through the API; the airport explorer shows all airports without hub filtering or hub details.

This airport dataset is not comprehensive aviation data or live schedules. Click a marker for airport details. Edit the airport JSON file and refresh the page to reload them; no server restart is needed. Keep airport IDs unique.

## Routes data

`GET /api/routes` serves the route list. Use the **Routes** sidebar beside the map (below it on small screens). Use **Add route** to choose origin, destination, and airline; use **Delete** beside a route to remove it. Changes are saved through the API and update the list immediately. Deleting the selected route also clears its map highlight. Select a connection to highlight its line and airports and fit them into view. **Clear selection** removes the highlight. Unknown airport or airline codes appear as unavailable entries. An empty list displays “No routes available yet.” Route lines illustrate connections, not actual flight paths.

`data/flightdiary.json` contains routes, collections, tags, and their associations. The `routes` array stores airport connections. Each entry connects two airport IATA codes and optionally identifies the operating airline by its IATA code. For example (illustrative, not a verified schedule):

```json
{
  "origin": "ZRH",
  "destination": "LHR",
  "airline": "LX"
}
```

Airport codes must exist in `airports.json` and any supplied airline code in `airlines.json`. Each entry represents one direction; add a separate entry for the reverse direction or another operating airline.

### Add or delete routes with the API

Restart the server after installing these endpoints. Both accept a JSON object with required `origin` and `destination`, and optional `airline`. Omit `airline`, or send null or an empty string, to leave it unspecified; it is saved as an empty string. Codes are trimmed and converted to uppercase. Routes are directional; their three codes identify them uniquely.

```sh
# Add a route
curl -X POST http://localhost:8000/api/routes \
  -H 'Content-Type: application/json' \
  -d '{"origin":"ZRH","destination":"LHR","airline":"LX"}'

# Delete that route
curl -X DELETE http://localhost:8000/api/routes \
  -H 'Content-Type: application/json' \
  -d '{"origin":"ZRH","destination":"LHR","airline":"LX"}'
```

Creation returns `201`; deletion returns `200`. Both return `{"route": {...}}`. Errors return `{"error": "..."}`: `400` for invalid input or unknown codes on creation, `409` for duplicates, `404` when deleting a missing route, and `500` for data-file failures. Deletion also works for an existing route whose airport or airline was subsequently removed from the reference data.

Changes persist in `data/flightdiary.json`. Updates are serialized within the server and saved through atomic file replacement. Refresh the page after an API change to reload the route list and map selection options.


## Collections and tags

Use **New collection** to choose a name, routes, and tags. Select a collection in the sidebar to view its routes; **Edit collection** changes its name and membership. **Manage tags** creates, renames, and deletes reusable tags. Each route's **Organize** button assigns collections and route tags. The collection and route-tag filters combine, and route selection still highlights the connection on the map.

Collections and tags have stable generated IDs. Routes are referenced by `ORIGIN:DESTINATION:AIRLINE`, for example `ZRH:DXB:EK`. A route can belong to multiple collections and have multiple tags. Collection tags are independent of route tags. Deleting a collection keeps its routes; deleting a route removes its collection memberships and tag assignments; deleting a tag removes all its assignments.

All organization data is stored alongside `routes` in `data/flightdiary.json`, under `collections`, `tags`, and `route_tags`. These are separate entity lists and associations in one file so related changes can be saved atomically. Existing route files need no migration; missing organization fields default to empty and are created on the first save.

| API | Body / result |
| --- | --- |
| `GET /api/organization` | Returns `collections`, `tags`, and `route_tags` |
| `GET /api/collections` | Returns the collections list |
| `GET /api/tags` | Returns the tags list |
| `POST /api/collections` | `{"name":"Summer","routes":["ZRH:DXB:EK"],"tag_ids":[]}` |
| `PATCH /api/collections/{id}` | Any of `name`, `routes`, `tag_ids`; provided lists replace existing lists |
| `DELETE /api/collections/{id}` | `{}` |
| `POST /api/tags` | `{"name":"Wishlist"}` |
| `PATCH /api/tags/{id}` | `{"name":"Visited"}` |
| `DELETE /api/tags/{id}` | `{}` |
| `PUT /api/route-tags` | `{"route":"ZRH:DXB:EK","tag_ids":[],"collection_ids":[]}`; omit `collection_ids` to keep collection memberships |

Mutation requests require JSON and use the same localhost/origin restrictions as route changes. Creation returns 201; other successful mutations return 200, with the updated organization snapshot. Names must be nonblank and at most 100 characters; duplicates within each entity type are rejected case-insensitively (409). Invalid associations return 400, missing IDs 404, and storage failures 500. Restart Python after installing the new endpoints, then refresh the page.

Routes without an airline display “No airline specified” and support selection, collections, and tags. Their collection reference ends with a colon, for example `ZRH:LHR:`. They are distinct from airline-specific routes between the same airports.

When adding a route in the dialog, select any existing collections and tags using the optional checkboxes. Current sidebar filters are preselected; clear them to add elsewhere. `POST /api/routes` also accepts optional `collection_ids` and `tag_ids` arrays. The server validates these references and saves the route and associations atomically. Its response includes both `route` and the updated `organization` snapshot. Create new names with **New collection** or **Manage tags** before opening the route dialog.

The sidebar search matches cities, airport names/codes, countries, and airline names/codes without case or accent sensitivity. Multiple search words must all match a route. Route results combine with collection and tag filters and highlight on the map. Airport results search all airports independently; select one to focus the map. Clear the search to restore the filtered route list.

### Airline icons

Route rows show locally bundled airline logos beside the airline name and IATA code.
Images are served at `/airlines/<IATA>.png`; unknown or unspecified airlines and
missing images retain their text labels. The airline selector remains text-only.
See [logo provenance and update instructions](static/airlines/README.md) for the
pinned source and trademark notice. No external logo service is needed at runtime.
