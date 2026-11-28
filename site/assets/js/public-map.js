// Weltkarte der Häfen auf der Startseite (Ländergrenzen von Natural Earth, keine Kartenkacheln von Dritten)
(() => {
  const el = document.getElementById('pub-map') || (document.getElementById('ports') && document.getElementById('map'));
  const data = JSON.parse(document.getElementById('ports')?.textContent || '[]');
  if (!el || !window.L) return;
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const map = L.map(el, { zoomSnap: 0.25, minZoom: 1.25, maxZoom: 9, worldCopyJump: true, attributionControl: true });
  map.attributionControl.setPrefix(false).addAttribution('Natural Earth');
  map.setView([25, 15], 2);
  fetch('/assets/geo/countries-50m.json').then((r) => r.json()).then((topo) => {
    const fc = topojson.feature(topo, topo.objects.countries);
    fc.features = fc.features.filter((f) => f.id !== '010');
    L.geoJSON(fc, { interactive: false, style: { color: css('--land-line'), weight: 0.6, fillColor: css('--land'), fillOpacity: 1 } }).addTo(map).bringToBack();
  });
  const pts = [];
  for (const p of data) {
    const m = L.circleMarker([p.la, p.lo], { radius: p.t ? 6 : 4, weight: 1.5, color: css('--surface-solid') || css('--surface'), fillColor: css('--accent'), fillOpacity: p.t ? 1 : 0.7 }).addTo(map);
    const a = document.createElement('a');
    a.href = `/hafen/${p.s}/`; a.textContent = p.n;
    const box = document.createElement('div');
    box.append(a, document.createElement('br'), Object.assign(document.createElement('small'), { textContent: p.c + (p.t ? ` · ${p.t} ${p.t === 1 ? 'Tipp' : 'Tipps'}` : '') }));
    m.bindPopup(box);
    pts.push([p.la, p.lo]);
  }
  if (pts.length) map.fitBounds(pts, { padding: [24, 24], maxZoom: 4 });
})();
