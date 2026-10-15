const $ = (id) => document.getElementById(id);
async function api(path, payload) {
  const response = await fetch(path, payload === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function health() {
  try {
    const data = await api('/api/health');
    $('health').textContent = 'Python is online';
    $('indicator').className = 'online';
    $('uptime').textContent = `Up ${data.uptime_seconds}s · ${location.host}`;
  } catch {
    $('health').textContent = 'Server unavailable';
    $('indicator').className = '';
    $('uptime').textContent = 'Start Python to reconnect';
  }
}
async function send(form, endpoint, payload) {
  const button = form.querySelector('button');
  button.disabled = true;
  $('result-meta').textContent = 'Request in progress…';
  const start = performance.now();
  try {
    const data = await api(endpoint, payload);
    $('result').textContent = JSON.stringify(data, null, 2);
    $('result-meta').textContent = `${data.status ? `Upstream HTTP ${data.status}` : 'Success'} · ${Math.round(performance.now() - start)} ms`;
  } catch (error) {
    $('result').textContent = error.message;
    $('result-meta').textContent = 'Request failed';
  } finally { button.disabled = false; }
}
$('local-form').addEventListener('submit', event => {
  event.preventDefault();
  send(event.currentTarget, '/api/echo', {message: $('message').value});
});
$('external-form').addEventListener('submit', event => {
  event.preventDefault();
  send(event.currentTarget, '/api/request', {connection: $('connection').value, path: $('path').value});
});
async function loadConnections() {
  try {
    const {connections} = await api('/api/connections');
    $('connection').replaceChildren();
    if (!connections.length) {
      $('connection').add(new Option('No connections configured', ''));
      $('connection-note').textContent = 'Add a service in connections.json, then refresh this page. See README.md for setup.';
    } else {
      connections.forEach(item => $('connection').add(new Option(item.name, item.name)));
      $('external-submit').disabled = false;
      $('connection-note').textContent = 'Credentials are added by Python and stay on the server.';
    }
  } catch (error) {
    $('connection').replaceChildren(new Option('Connections unavailable', ''));
    $('connection-note').textContent = error.message;
  }
}
health(); loadConnections(); setInterval(health, 10000);

$('open-tools').addEventListener('click', () => $('server-tools').showModal());
$('close-tools').addEventListener('click', () => $('server-tools').close());
