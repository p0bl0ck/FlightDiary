// Run with static/organization.js loaded in a JavaScript runtime.
function checkRTW(condition, message) { if (!condition) throw new Error(message); }
const leg = (origin, destination, airline = '') => ({origin, destination, airline});
const shuffled = [leg('NRT', 'HNL'), leg('HNL', 'ZRH'), leg('ZRH', 'NRT')];
const original = JSON.stringify(shuffled);
const ordered = orderRTWRoutes(shuffled);
checkRTW(ordered.complete && ordered.routes.map(r => r.origin).join(',') === 'ZRH,NRT,HNL', 'Order from ZRH');
checkRTW(JSON.stringify(shuffled) === original, 'Input must remain unchanged');
const loop = orderRTWRoutes([leg('ZRH', 'LHR'), leg('ZRH', 'DXB'), leg('DXB', 'ZRH')]);
checkRTW(loop.complete && loop.routes.map(r => r.origin).join(',') === 'ZRH,DXB,ZRH', 'Visit loop before terminal leg');
for (const routes of [[leg('DXB', 'HKG')], [leg('ZRH', 'DXB'), leg('LHR', 'JNB')], [leg('ZRH', 'DXB'), leg('ZRH', 'LHR')]]) {
  const result = orderRTWRoutes(routes);
  checkRTW(!result.complete && result.routes.length === routes.length && new Set(result.routes).size === routes.length, 'Keep disconnected or branched legs');
}
checkRTW(orderRTWRoutes([]).complete, 'Empty collection');
