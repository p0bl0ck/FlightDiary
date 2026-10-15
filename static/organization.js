// Order directed legs without changing stored routes or collection membership.
function orderRTWRoutes(routes) {
  const outgoing = new Map();
  routes.forEach((route, index) => {
    if (!outgoing.has(route.origin)) outgoing.set(route.origin, []);
    outgoing.get(route.origin).push(index);
  });
  // Build a trail using each leg once, including loops that revisit an airport.
  const stack = [{airport: 'ZRH', leg: null}];
  const reversed = [];
  const remaining = new Map([...outgoing].map(([airport, legs]) => [airport, [...legs].reverse()]));
  while (stack.length) {
    const next = remaining.get(stack[stack.length - 1].airport);
    if (next?.length) {
      const leg = next.pop();
      stack.push({airport: routes[leg].destination, leg});
    } else {
      const {leg} = stack.pop();
      if (leg !== null) reversed.push(leg);
    }
  }
  const trail = reversed.reverse();
  const complete = trail.length === routes.length && trail.every((index, position) =>
    routes[index].origin === (position ? routes[trail[position - 1]].destination : 'ZRH'));
  if (complete) return {routes: trail.map(index => routes[index]), complete: true};
  // For incomplete itineraries show the connected prefix, then all remaining legs.
  const unused = new Set(routes.map((_, index) => index));
  const ordered = [];
  let airport = 'ZRH';
  while (unused.size) {
    const index = [...unused].find(index => routes[index].origin === airport);
    if (index === undefined) break;
    unused.delete(index); ordered.push(routes[index]); airport = routes[index].destination;
  }
  return {routes: [...ordered, ...[...unused].map(index => routes[index])], complete: false};
}

async function initializeOrganization(getRoutes, routeLabel, changed) {
  const el = id => document.getElementById(id);
  let data = {collections: [], tags: [], route_tags: {}};
  let busy = false;
  const key = route => [route.origin, route.destination, route.airline].join(':');
  const dialog = el('organization-dialog');
  const editor = el('organization-editor');
  const collectionFilter = el('collection-filter');
  const tagFilter = el('tag-filter');
  async function request(path, method, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, {method, signal: controller.signal,
        ...(body === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Request failed.');
      return result;
    } finally { clearTimeout(timer); }
  }
  function button(text, action) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
    b.addEventListener('click', action); return b;
  }
  function chips(ids, target) {
    for (const id of ids) {
      const tag = data.tags.find(item => item.id === id);
      if (tag) { const chip = document.createElement('span'); chip.className = 'tag-chip'; chip.textContent = tag.name; target.append(chip); }
    }
  }
  function refreshControls() {
    for (const [select, items, title] of [[collectionFilter, data.collections, 'All routes'], [tagFilter, data.tags, 'All tags']]) {
      const previous = select.value;
      select.replaceChildren(new Option(title, ''));
      items.forEach(item => select.add(new Option(item.name, item.id)));
      select.value = items.some(item => item.id === previous) ? previous : '';
      select.disabled = false;
    }
    el('edit-collection').disabled = !collectionFilter.value;
    el('new-collection').disabled = false; el('manage-tags').disabled = false;
    el('collection-tags').replaceChildren();
    chips(data.collections.find(item => item.id === collectionFilter.value)?.tag_ids || [], el('collection-tags'));
  }
  async function save(path, method, payload, done) {
    if (busy) return;
    busy = true;
    editor.querySelectorAll('button,input').forEach(input => { input.disabled = true; });
    el('close-organization').disabled = true;
    el('organization-feedback').textContent = 'Saving…';
    try {
      data = await request(path, method, payload);
      refreshControls(); changed();
      el('organization-feedback').textContent = 'Saved.';
      done?.();
    } catch (error) {
      el('organization-feedback').textContent = error.name === 'AbortError' ? 'Request timed out. Reload to check whether it was saved.' : error.message;
    } finally {
      busy = false;
      editor.querySelectorAll('button,input').forEach(input => { input.disabled = false; });
      el('close-organization').disabled = false;
    }
  }
  function open(title) {
    el('organization-title').textContent = title; editor.replaceChildren();
    el('organization-feedback').textContent = '';
    if (!dialog.open) dialog.showModal();
  }
  function checks(title, items, selected) {
    const group = document.createElement('fieldset'); group.className = 'organization-checks';
    const legend = document.createElement('legend'); legend.textContent = title; group.append(legend);
    if (!items.length) { const p = document.createElement('p'); p.textContent = `No ${title.toLowerCase()} available yet.`; group.append(p); }
    for (const item of items) {
      const label = document.createElement('label'); const input = document.createElement('input');
      input.type = 'checkbox'; input.value = item.id; input.checked = selected.includes(item.id);
      label.append(input, document.createTextNode(item.name)); group.append(label);
    }
    group.values = () => [...group.querySelectorAll('input:checked')].map(input => input.value);
    return group;
  }
  function nameInput(name, labelText) {
    const label = document.createElement('label'); label.textContent = labelText;
    const input = document.createElement('input'); input.required = true; input.maxLength = 100; input.value = name;
    label.append(input); return [label, input];
  }
  function editCollection(collection) {
    open(collection ? 'Edit collection' : 'New collection');
    const form = document.createElement('form');
    const [label, input] = nameInput(collection?.name || '', 'Collection name');
    const routes = checks('Routes', getRoutes().map(route => ({id: key(route), name: routeLabel(route)})), collection?.routes || []);
    const tags = checks('Tags', data.tags, collection?.tag_ids || []);
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Save collection';
    form.append(label, routes, tags, submit); editor.append(form);
    form.addEventListener('submit', event => {
      event.preventDefault();
      save('/api/collections' + (collection ? '/' + collection.id : ''), collection ? 'PATCH' : 'POST',
        {name: input.value, routes: routes.values(), tag_ids: tags.values()}, () => dialog.close());
    });
    if (collection) editor.append(button('Delete collection (keep routes)', () => save('/api/collections/' + collection.id, 'DELETE', {}, () => dialog.close())));
  }
  function manageTags() {
    open('Manage tags');
    const create = document.createElement('form'); const [label, input] = nameInput('', 'New tag name');
    const add = document.createElement('button'); add.type = 'submit'; add.textContent = 'Create tag';
    create.append(label, add); editor.append(create);
    create.addEventListener('submit', event => { event.preventDefault(); save('/api/tags', 'POST', {name: input.value}, manageTags); });
    for (const tag of data.tags) {
      const row = document.createElement('form'); row.className = 'tag-editor-row';
      const [label, name] = nameInput(tag.name, 'Tag name');
      const rename = document.createElement('button'); rename.type = 'submit'; rename.textContent = 'Rename';
      const remove = button('Delete', () => save('/api/tags/' + tag.id, 'DELETE', {}, manageTags));
      remove.setAttribute('aria-label', `Delete tag ${tag.name}`);
      row.append(label, rename, remove); editor.append(row);
      row.addEventListener('submit', event => { event.preventDefault(); save('/api/tags/' + tag.id, 'PATCH', {name: name.value}, manageTags); });
    }
  }
  function editRoute(route) {
    open('Organize ' + routeLabel(route));
    const collections = checks('Collections', data.collections, data.collections.filter(item => item.routes.includes(key(route))).map(item => item.id));
    const tags = checks('Tags', data.tags, data.route_tags[key(route)] || []);
    editor.append(collections, tags, button('Save', () => save('/api/route-tags', 'PUT',
      {route: key(route), tag_ids: tags.values(), collection_ids: collections.values()}, () => dialog.close())));
  }
  el('close-organization').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  el('new-collection').addEventListener('click', () => editCollection(null));
  el('edit-collection').addEventListener('click', () => editCollection(data.collections.find(item => item.id === collectionFilter.value)));
  el('manage-tags').addEventListener('click', manageTags);
  for (const select of [collectionFilter, tagFilter]) select.addEventListener('change', () => { refreshControls(); changed(); });
  try {
    data = await request('/api/organization', 'GET'); refreshControls();
  } catch (error) {
    el('organization-status').textContent = `Collections unavailable: ${error.message}. Reload to retry.`;
    return null;
  }
  return {
    addRouteChoices(target) {
      const collections = checks('Collections (optional)', data.collections, collectionFilter.value ? [collectionFilter.value] : []);
      const tags = checks('Tags (optional)', data.tags, tagFilter.value ? [tagFilter.value] : []);
      target.replaceChildren(collections, tags);
      return () => ({collection_ids: collections.values(), tag_ids: tags.values()});
    },
    update(snapshot) { data = snapshot; refreshControls(); },
    orderRoutes(routes) {
      const collection = data.collections.find(item => item.id === collectionFilter.value);
      const rtw = collection?.tag_ids.some(id => data.tags.some(tag => tag.id === id && tag.name.trim().toUpperCase() === 'RTW'));
      const note = el('route-order-note');
      note.hidden = !rtw;
      if (!rtw) return routes;
      const result = orderRTWRoutes(routes.filter(route => collection.routes.includes(key(route))));
      note.textContent = result.complete ? 'RTW itinerary · starting from Zurich (ZRH)' :
        'RTW itinerary cannot form one continuous chain from ZRH. Connected legs appear first; remaining legs follow.';
      return result.routes;
    },
    hasFilter() { return Boolean(collectionFilter.value || tagFilter.value); },
    visible(route) {
      const collection = data.collections.find(item => item.id === collectionFilter.value);
      return (!collection || collection.routes.includes(key(route))) && (!tagFilter.value || (data.route_tags[key(route)] || []).includes(tagFilter.value));
    },
    decorate(route, item) {
      const tags = document.createElement('div'); tags.className = 'route-tags'; chips(data.route_tags[key(route)] || [], tags);
      const action = button('Organize', () => editRoute(route)); action.className = 'organize-route';
      action.setAttribute('aria-label', `Organize ${routeLabel(route)}`); item.append(tags, action);
    },
    removed(route) {
      delete data.route_tags[key(route)];
      data.collections.forEach(collection => { collection.routes = collection.routes.filter(id => id !== key(route)); });
    }
  };
}
