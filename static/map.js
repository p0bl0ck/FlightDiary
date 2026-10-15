async function initializeMap() {
  const status = document.getElementById('map-status');
  let stage = 'map library and airport data';
  const timeout = setTimeout(() => {
    status.textContent = `Map startup timed out while loading ${stage}. Reload to retry.`;
  }, 20000);
  function policyViolation(event) {
    if (!['script-src', 'script-src-elem', 'worker-src', 'connect-src', 'img-src'].includes(event.effectiveDirective)) return;
    clearTimeout(timeout);
    status.textContent = `Map resource blocked by ${event.effectiveDirective}: ${event.blockedURI}`;
  }
  document.addEventListener('securitypolicyviolation', policyViolation);
  try {
    status.textContent = 'Loading map library and airport data…';
    const [maplibregl, airportsResponse] = await Promise.all([
      import('/vendor/maplibre-gl/maplibre-gl.mjs'),
      fetch('/api/airports')
    ]);
    if (!airportsResponse.ok) throw new Error('Could not load map data from the server.');
    const airports = await airportsResponse.json();
    stage = 'basemap and map worker';
    status.textContent = 'Loading basemap and map worker…';
    // A same-origin module worker avoids the CDN's temporary Blob bootstrap.
    maplibregl.setWorkerUrl('/vendor/maplibre-gl/maplibre-gl-worker.mjs');
    const zoom = document.getElementById('map-zoom');
    const zoomValue = document.getElementById('map-zoom-value');
    const map = new maplibregl.Map({
      container: 'map', 
      style: 'https://demotiles.maplibre.org/style.json',
      center: [0, 0], 
      minZoom: Number(zoom.min),
      maxZoom: Number(zoom.max),
      zoom: Number(zoom.value)
    });
    const mapResizeObserver = new ResizeObserver(() => map.resize());
    mapResizeObserver.observe(document.getElementById('map'));
    function updateZoomControl() {
      const value = map.getZoom().toFixed(1);
      zoom.value = value;
      zoomValue.value = value;
      zoom.setAttribute('aria-valuetext', `Zoom level ${value}`);
    }
    zoom.addEventListener('input', () => {
      map.stop();
      map.setZoom(Number(zoom.value));
    });
    map.on('zoom', updateZoomControl);
    updateZoomControl();
    map.on('error', event => {
      clearTimeout(timeout);
      status.textContent = `Map resource failed: ${event.error?.message || 'Unknown error. Check the browser console.'}`;
    });
    map.on('load', () => {
      clearTimeout(timeout);
      document.removeEventListener('securitypolicyviolation', policyViolation);
      map.addSource('airports', {type: 'geojson', data: airports});
      map.addLayer({id: 'airports', type: 'circle', source: 'airports', paint: {
        'circle-radius': 8, 'circle-color': '#195ccb', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2
      }});
      zoom.disabled = false;
      let popup;
      const features = airports.features;
      status.textContent = `${features.length} airport${features.length === 1 ? '' : 's'} shown`;
      function resetMapView() {
        map.stop();
        popup?.remove();
        if (features.length) {
          const bounds = new maplibregl.LngLatBounds();
          features.forEach(feature => bounds.extend(feature.geometry.coordinates));
          map.fitBounds(bounds, {padding: 60, maxZoom: Math.min(7, map.getMaxZoom()), bearing: 0, pitch: 0, duration: 0});
        } else {
          map.jumpTo({center: [0, 0], zoom: Number(zoom.defaultValue), bearing: 0, pitch: 0});
        }
      }
      resetMapView();
      initializeRoutes(map, maplibregl, airports, () => popup?.remove(), resetMapView);
      map.on('mouseenter', 'airports', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'airports', () => { map.getCanvas().style.cursor = ''; });
      map.on('click', 'airports', event => {
        const feature = event.features[0];
        const airport = feature.properties;
        const content = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = `${airport.iata} · ${airport.name}`;
        const details = document.createElement('div');
        details.textContent = `${airport.city}, ${airport.country}`;
        content.append(title, details);
        popup?.remove();
        popup = new maplibregl.Popup().setLngLat(feature.geometry.coordinates).setDOMContent(content).addTo(map);
      });
    });
  } catch (error) {
    clearTimeout(timeout);
    document.removeEventListener('securitypolicyviolation', policyViolation);
    status.textContent = `Map unavailable: ${error.message} MapLibre requires internet access and WebGL support.`;
  }
}
initializeMap();

async function initializeRoutes(map, maplibregl, airports, closePopup, resetMapView) {
  const list = document.getElementById('route-list');
  const status = document.getElementById('routes-status');
  const clear = document.getElementById('clear-route');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const empty = {type: 'FeatureCollection', features: []};
  try {
    const responses = await Promise.all([
      fetch('/api/routes', {signal: controller.signal}),
      fetch('/api/airlines', {signal: controller.signal})
    ]);
    if (responses.some(response => !response.ok)) throw new Error('Could not load routes.');
    let [{routes}, {airlines}] = await Promise.all(responses.map(response => response.json()));
    if (!Array.isArray(routes) || !Array.isArray(airlines)) throw new Error('Invalid route data.');
    const airportByCode = new Map(airports.features.map(feature => [feature.properties.iata, feature]));
    const airlineByCode = new Map(airlines.map(airline => [airline.iata, airline]));
    map.addSource('selected-route', {type: 'geojson', data: empty});
    map.addLayer({id: 'selected-route', type: 'line', source: 'selected-route', paint: {
      'line-color': '#d44713', 'line-width': 4
    }}, 'airports');
    map.addSource('route-endpoints', {type: 'geojson', data: empty});
    map.addLayer({id: 'route-endpoints', type: 'circle', source: 'route-endpoints', paint: {
      'circle-radius': 12, 'circle-color': '#d44713', 'circle-opacity': 0.25,
      'circle-stroke-color': '#d44713', 'circle-stroke-width': 3
    }}, 'airports');
    let organizer = null;
    const search = document.getElementById('route-search');
    const clearSearch = document.getElementById('clear-search');
    const airportResults = document.getElementById('airport-search-results');
    const airportList = document.getElementById('airport-search-list');
    const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const terms = () => normalize(search.value).trim().split(/\s+/).filter(Boolean);
    const matches = text => terms().every(term => normalize(text).includes(term));
    const airportText = airport => airport ? Object.values(airport.properties).join(' ') : '';
    const visibleRoutes = () => (organizer ? organizer.orderRoutes(routes) : routes).filter(route => (!organizer || organizer.visible(route)) && matches([
      airportText(airportByCode.get(route.origin)), airportText(airportByCode.get(route.destination)),
      route.origin, route.destination, route.airline, airlineByCode.get(route.airline)?.name
    ].join(' ')));
    function renderAirportResults() {
      airportList.replaceChildren();
      airportResults.hidden = terms().length === 0;
      clearSearch.hidden = search.value.length === 0;
      if (airportResults.hidden) return;
      const found = airports.features.filter(airport => matches(airportText(airport)));
      document.getElementById('airport-search-status').textContent = `${found.length} matching airport${found.length === 1 ? '' : 's'}`;
      for (const airport of found) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `${airport.properties.city} (${airport.properties.iata}) · ${airport.properties.name}`;
        button.addEventListener('click', () => {
          clearSelection();
          closePopup();
          map.getSource('route-endpoints').setData({type: 'FeatureCollection', features: [airport]});
          map.jumpTo({center: airport.geometry.coordinates, zoom: Math.min(8, map.getMaxZoom()), bearing: 0, pitch: 0});
          status.textContent = `Airport: ${airport.properties.city} (${airport.properties.iata})`;
          clear.hidden = false;
        });
        item.append(button); airportList.append(item);
      }
    }
    search.addEventListener('input', () => { renderAirportResults(); highlightFilteredRoutes(); });
    clearSearch.addEventListener('click', () => {
      search.value = ''; renderAirportResults(); highlightFilteredRoutes(); search.focus();
    });
    search.disabled = false;
    const countText = () => `${visibleRoutes().length} route${visibleRoutes().length === 1 ? '' : 's'}`;
    status.textContent = routes.length ? `${countText()}. Select a route to highlight it.` : 'No routes available yet.';
    let selectedKey = null;
    const routeKey = route => JSON.stringify([route?.origin, route?.destination, route?.airline || '']);
    function resetSelection() {
      list.querySelectorAll('button[aria-pressed]').forEach(button => button.setAttribute('aria-pressed', 'false'));
    }
    function clearSelection() {
      selectedKey = null;
      resetSelection();
      map.getSource('selected-route').setData(empty);
      map.getSource('route-endpoints').setData(empty);
      status.textContent = `${countText()}. Select a route to highlight it.`;
      clear.hidden = true;
    }
    function highlightFilteredRoutes() {
      clearSelection();
      closePopup();
      renderRoutes();
      if (!organizer?.hasFilter() && !terms().length) {
        resetMapView();
        return;
      }
      const lines = [];
      const endpoints = new Map();
      const bounds = new maplibregl.LngLatBounds();
      let anchor;
      for (const route of visibleRoutes()) {
        const origin = airportByCode.get(route.origin);
        const destination = airportByCode.get(route.destination);
        if (!origin || !destination || route.origin === route.destination) continue;
        const start = [...origin.geometry.coordinates];
        const end = [...destination.geometry.coordinates];
        if (anchor === undefined) anchor = start[0];
        while (start[0] - anchor > 180) start[0] -= 360;
        while (start[0] - anchor < -180) start[0] += 360;
        while (end[0] - start[0] > 180) end[0] -= 360;
        while (end[0] - start[0] < -180) end[0] += 360;
        lines.push({type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: [start, end]}});
        endpoints.set(route.origin, origin);
        endpoints.set(route.destination, destination);
        bounds.extend(start).extend(end);
      }
      map.getSource('selected-route').setData({type: 'FeatureCollection', features: lines});
      map.getSource('route-endpoints').setData({type: 'FeatureCollection', features: [...endpoints.values()]});
      if (lines.length) {
        map.fitBounds(bounds, {padding: 60, maxZoom: Math.min(7, map.getMaxZoom()), bearing: 0, pitch: 0, duration: 0});
        status.textContent = `${lines.length} matching route${lines.length === 1 ? '' : 's'} highlighted.`;
        clear.hidden = false;
      } else {
        resetMapView();
      }
    }
    clear.addEventListener('click', () => {
      clearSelection();
      resetMapView();
    });
    function renderRoutes() {
      list.replaceChildren();
      if (!selectedKey) status.textContent = visibleRoutes().length ? `${countText()}. Select a route to highlight it.` : (routes.length ? 'No routes match your search and filters.' : 'No routes available yet.');
      visibleRoutes().forEach(route => {
        const origin = airportByCode.get(route?.origin);
        const destination = airportByCode.get(route?.destination);
        const airline = airlineByCode.get(route?.airline);
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(routeKey(route) === selectedKey));
        const originLabel = origin?.properties.city ? `${origin.properties.city} (${route.origin})` : (route?.origin || '?');
        const destinationLabel = destination?.properties.city ? `${destination.properties.city} (${route.destination})` : (route?.destination || '?');
        const airlineLabel = route?.airline ? `${airline?.name || route.airline} (${route.airline})` : 'No airline specified';
        const label = `${originLabel} → ${destinationLabel} · ${airlineLabel}`;
        const journey = document.createElement('span');
        journey.className = 'route-journey';
        const departure = document.createElement('span');
        departure.textContent = originLabel;
        const arrival = document.createElement('span');
        arrival.textContent = destinationLabel;
        journey.append(departure, arrival);
        const carrier = document.createElement('span');
        carrier.className = 'route-carrier';
        if (airline && /^[A-Z0-9]{2}$/.test(route.airline)) {
          const icon = document.createElement('img');
          icon.className = 'airline-icon';
          icon.alt = '';
          icon.width = 24;
          icon.height = 24;
          icon.addEventListener('error', () => { icon.hidden = true; }, {once: true});
          icon.src = `/airlines/${route.airline}.png`;
          carrier.append(icon);
        }
        const carrierLabel = document.createElement('span');
        carrierLabel.textContent = airlineLabel;
        carrier.append(carrierLabel);
        button.append(journey, carrier);
        if (!origin || !destination || (route.airline && !airline) || route.origin === route.destination) {
          button.disabled = true;
          button.append(document.createTextNode(' — unavailable: invalid airport or airline'));
        } else {
          button.addEventListener('click', () => {
            selectedKey = routeKey(route);
            resetSelection();
            button.setAttribute('aria-pressed', 'true');
            closePopup();
            const start = [...origin.geometry.coordinates];
            const end = [...destination.geometry.coordinates];
            // Cross the date line by the shorter path, rather than spanning the world.
            while (end[0] - start[0] > 180) end[0] -= 360;
            while (end[0] - start[0] < -180) end[0] += 360;
            map.getSource('selected-route').setData({type: 'Feature', properties: {}, geometry: {
              type: 'LineString', coordinates: [start, end]
            }});
            map.getSource('route-endpoints').setData({type: 'FeatureCollection', features: [origin, destination]});
            const bounds = new maplibregl.LngLatBounds(start, start).extend(end);
            map.fitBounds(bounds, {padding: 60, maxZoom: Math.min(7, map.getMaxZoom()), duration: 0});
            status.textContent = `Selected: ${label}`;
            clear.hidden = false;
          });
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'delete-route';
        remove.textContent = '×';
        remove.title = `Delete ${label}`;
        remove.setAttribute('aria-label', `Delete ${label}`);
        remove.addEventListener('click', () => mutateRoute('DELETE', route));
        item.append(button, remove);
        organizer?.decorate(route, item);
        list.append(item);
      });
    }
    const form = document.getElementById('route-form');
    const fields = document.getElementById('route-fields');
    const feedback = document.getElementById('route-feedback');
    const originInput = document.getElementById('route-origin');
    const destinationInput = document.getElementById('route-destination');
    const airlineInput = document.getElementById('route-airline');
    for (const input of [originInput, destinationInput]) {
      input.add(new Option('Choose airport', ''));
      [...airportByCode.entries()].sort(([aCode, a], [bCode, b]) =>
        a.properties.city.localeCompare(b.properties.city) || aCode.localeCompare(bCode)
      ).forEach(([code, airport]) => {
        input.add(new Option(`${airport.properties.city} (${code})`, code));
      });
    }
    airlineInput.add(new Option('No airline specified', ''));
    airlines.forEach(airline => airlineInput.add(new Option(`${airline.name} (${airline.iata})`, airline.iata)));
    let saving = false;
    const routeDialog = document.getElementById('route-dialog');
    const openRoute = document.getElementById('open-route-dialog');
    const closeRoute = document.getElementById('close-route-dialog');
    const addFeedback = document.getElementById('add-route-feedback');
    let routeAssociations = () => ({});
    openRoute.addEventListener('click', () => {
      const choices = document.getElementById('new-route-organization');
      if (organizer) routeAssociations = organizer.addRouteChoices(choices);
      else choices.textContent = 'Collections and tags are unavailable. Reload to retry.';
      addFeedback.textContent = '';
      routeDialog.showModal();
      originInput.focus();
    });
    closeRoute.addEventListener('click', () => routeDialog.close());
    routeDialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    async function mutateRoute(method, route) {
      if (saving) return;
      saving = true;
      const feedback = method === 'POST' ? addFeedback : document.getElementById('route-feedback');
      closeRoute.disabled = true;
      openRoute.disabled = true;
      fields.disabled = true;
      list.querySelectorAll('.delete-route').forEach(button => { button.disabled = true; });
      feedback.textContent = method === 'POST' ? 'Adding route…' : 'Deleting route…';
      const requestController = new AbortController();
      const requestTimer = setTimeout(() => requestController.abort(), 15000);
      try {
        const response = await fetch('/api/routes', {
          method, headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({origin: route.origin, destination: route.destination, airline: route.airline, ...(method === 'POST' ? routeAssociations() : {})}),
          signal: requestController.signal
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not save route.');
        if (method === 'POST') {
          routes.push(result.route);
          if (result.organization) organizer?.update(result.organization);
          form.reset();
          routeDialog.close();
          document.getElementById('route-feedback').textContent = 'Route added.';
        } else {
          organizer?.removed(route);
          routes = routes.filter(item => routeKey(item) !== routeKey(route));
          if (selectedKey === routeKey(route)) clearSelection();
        }
        renderRoutes();
        if (!selectedKey && (organizer?.hasFilter() || terms().length)) highlightFilteredRoutes();
        feedback.textContent = method === 'POST' ? 'Route added.' : 'Route deleted.';
      } catch (error) {
        feedback.textContent = error.name === 'AbortError'
          ? 'Request timed out. Reload to check whether the change was saved.'
          : `Could not save change: ${error.message}`;
      } finally {
        clearTimeout(requestTimer);
        saving = false;
        closeRoute.disabled = false;
        openRoute.disabled = false;
        fields.disabled = false;
        list.querySelectorAll('.delete-route').forEach(button => { button.disabled = false; });
      }
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (originInput.value === destinationInput.value) {
        addFeedback.textContent = 'Choose two different airports.';
        destinationInput.focus();
        return;
      }
      mutateRoute('POST', {origin: originInput.value, destination: destinationInput.value, airline: airlineInput.value});
    });
    renderRoutes();
    organizer = await initializeOrganization(() => routes, route => {
      const origin = airportByCode.get(route.origin)?.properties.city || route.origin;
      const destination = airportByCode.get(route.destination)?.properties.city || route.destination;
      return `${origin} (${route.origin}) → ${destination} (${route.destination}) · ${route.airline || 'No airline specified'}`;
    }, highlightFilteredRoutes);
    renderRoutes();
    fields.disabled = false;
    openRoute.disabled = false;
  } catch (error) {
    status.textContent = error.name === 'AbortError' ? 'Routes timed out. Reload to retry.' : `Routes unavailable: ${error.message}`;
  } finally {
    clearTimeout(timer);
  }
}
