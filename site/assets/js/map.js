// Weltkarte mit Leaflet – ohne Kachel-Server, die Landflächen kommen aus Natural Earth (world-atlas).
/* global L, topojson */
import { esc, fmt } from './charts.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmtDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

// Großkreis-Zwischenpunkte, damit lange Strecken als Bogen erscheinen
function greatCircle(a, b) {
  const rad = Math.PI / 180;
  const [la1, lo1, la2, lo2] = [a[0] * rad, a[1] * rad, b[0] * rad, b[1] * rad];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
  const steps = Math.max(1, Math.ceil((d * 6371) / 250));
  if (steps === 1 || d === 0) return [a, b];
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    pts.push([Math.atan2(z, Math.hypot(x, y)) / rad, Math.atan2(y, x) / rad]);
  }
  return pts;
}

// Längengrade ohne Sprung über die Datumsgrenze
function unwrap(pts) {
  const out = [pts[0].slice()];
  for (let i = 1; i < pts.length; i++) {
    let lng = pts[i][1];
    const prev = out[i - 1][1];
    while (lng - prev > 180) lng -= 360;
    while (lng - prev < -180) lng += 360;
    out.push([pts[i][0], lng]);
  }
  return out;
}

function shiftGeometry(geom, dx) {
  const mapC = (c) => (typeof c[0] === 'number' ? [c[0] + dx, c[1]] : c.map(mapC));
  return { ...geom, coordinates: mapC(geom.coordinates) };
}

// Ringe, die über die Datumsgrenze springen (Russland, Fidschi …), stetig machen
function unwrapGeometry(geom) {
  const ring = (r) => {
    const out = [r[0].slice()];
    for (let i = 1; i < r.length; i++) {
      let x = r[i][0];
      const prev = out[i - 1][0];
      while (x - prev > 180) x -= 360;
      while (x - prev < -180) x += 360;
      out.push([x, r[i][1]]);
    }
    return out;
  };
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const fixed = polys.map((p) => p.map(ring));
  return geom.type === 'Polygon' ? { ...geom, coordinates: fixed[0] } : { ...geom, coordinates: fixed };
}

export class TripMap {
  constructor(elId, { onSelectCruise }) {
    this.onSelectCruise = onSelectCruise;
    this.map = L.map(elId, {
      preferCanvas: true, zoomSnap: 0.25, minZoom: 1.25, maxZoom: 9, worldCopyJump: false,
      maxBounds: [[-75, -400], [85, 400]], maxBoundsViscosity: 0.8, attributionControl: true,
    });
    this.map.attributionControl.setPrefix(false).addAttribution('Natural Earth');
    this.map.setView([25, 15], 2);
    this.layers = { countries: L.layerGroup().addTo(this.map), routes: L.layerGroup().addTo(this.map), ports: L.layerGroup().addTo(this.map) };
    this.selected = null;
    this.ready = fetch('assets/geo/countries-50m.json').then((r) => r.json()).then((topo) => {
      const fc = topojson.feature(topo, topo.objects.countries);
      const base = fc.features.filter((f) => f.id !== '010' && f.geometry).map((f) => ({ ...f, geometry: unwrapGeometry(f.geometry) }));
      // Zwei Kopien links/rechts, damit Routen über die Datumsgrenze auf Land treffen
      this.features = [-360, 0, 360].flatMap((dx) => base.map((f) => ({ ...f, geometry: dx ? shiftGeometry(f.geometry, dx) : f.geometry })));
    });
  }

  toggle(layer, on) {
    if (on) this.layers[layer].addTo(this.map); else this.layers[layer].remove();
  }

  async render(model) {
    await this.ready;
    this.model = model;
    this.colors = {
      land: css('--land'), line: css('--land-line'), surface: css('--surface'), accent: css('--accent'),
      seq: [1, 2, 3, 4, 5, 6].map((i) => css(`--seq-${i}`)),
    };
    this.drawCountries();
    this.drawRoutes();
    this.drawPorts();
    if (this.selected != null && !model.cruises.some((c) => c.id === this.selected)) this.select(null);
    else if (this.selected != null) this.select(this.selected, false);
    if (!this.fitted) { this.fitAll(); this.fitted = true; }
  }

  fitAll() {
    const pts = this.model.ports.map((p) => [p.lat, p.lng]);
    if (pts.length) this.map.fitBounds(pts, { padding: [24, 24], maxZoom: 4 });
  }

  drawCountries() {
    const g = this.layers.countries;
    g.clearLayers();
    const visits = this.model.countryVisits; // numerischer ISO-Code -> Besuche
    const max = Math.max(1, ...visits.values());
    const shade = (n) => {
      const v = visits.get(n);
      if (!v) return null;
      return this.colors.seq[Math.min(4, Math.floor((Math.log(v) / Math.log(max + 1)) * 4))];
    };
    L.geoJSON({ type: 'FeatureCollection', features: this.features }, {
      interactive: false,
      style: (f) => {
        const fill = shade(f.id);
        return { color: this.colors.line, weight: 0.6, fillColor: fill || this.colors.land, fillOpacity: fill ? 0.85 : 1 };
      },
    }).addTo(g);
  }

  routeColor(c) {
    const { first, last } = this.model.yearSpan;
    const f = last > first ? (new Date(c.start).getFullYear() - first) / (last - first) : 1;
    return this.colors.seq[2 + Math.round(f * 3)];
  }

  drawRoutes() {
    const g = this.layers.routes;
    g.clearLayers();
    this.routeLayers = new Map();
    for (const c of this.model.cruises) {
      const pts = c.legs.map((s) => [s.lat, s.lng]);
      if (pts.length < 2) continue;
      let line = [];
      for (let i = 1; i < pts.length; i++) {
        const seg = greatCircle(pts[i - 1], pts[i]);
        line = line.concat(i > 1 ? seg.slice(1) : seg);
      }
      line = unwrap(line);
      const lngs = line.map((p) => p[1]);
      const copies = [0];
      if (Math.max(...lngs) > 180) copies.push(-360);
      if (Math.min(...lngs) < -180) copies.push(360);
      const style = { color: this.routeColor(c), weight: 2, opacity: 0.75, dashArray: c.planned ? '6 6' : null, lineCap: 'round', lineJoin: 'round' };
      const group = L.featureGroup(copies.map((dx) => L.polyline(line.map(([la, lo]) => [la, lo + dx]), style)));
      group.bindTooltip(`<b>${esc(c.ship)}</b><br>${esc(c.route)}<br><span class="muted">${fmtDate(c.start)} · ${c.nights} Nächte</span>`, { sticky: true, className: 'port-label' });
      group.on('mouseover', () => { if (this.selected == null) group.setStyle({ weight: 4, opacity: 1 }); });
      group.on('mouseout', () => { if (this.selected == null) group.setStyle({ weight: 2, opacity: 0.75 }); });
      group.on('click', () => this.onSelectCruise(c.id));
      group.addTo(g);
      this.routeLayers.set(c.id, { group, style });
    }
  }

  drawPorts() {
    const g = this.layers.ports;
    g.clearLayers();
    this.portLayers = [];
    const max = Math.max(1, ...this.model.ports.map((p) => p.visits.length));
    for (const p of this.model.ports) {
      const r = 3.5 + 6.5 * Math.sqrt(p.visits.length / max);
      const isLand = p.visits.every((v) => v.type === 'Landaufenthalt');
      const m = L.circleMarker([p.lat, p.lng], {
        radius: r, weight: 2, color: this.colors.surface, fillColor: isLand ? this.colors.seq[2] : this.colors.accent, fillOpacity: 1,
      });
      const list = p.visits.slice().reverse().map((v) => `<li>${fmtDate(v.d)} · ${v.cruise ? esc(v.cruise.ship) : 'an Land'}${v.type === 'Passage' ? ' · Passage' : ''}</li>`).join('');
      m.bindTooltip(`<b>${esc(p.port)}</b> · ${esc(p.country)}<br><span class="muted">${p.visits.length} ${p.visits.length === 1 ? 'Besuch' : 'Besuche'}</span>`, { className: 'port-label', direction: 'top', offset: [0, -r] });
      m.bindPopup(`<h3>${esc(p.port)}</h3><p class="muted">${esc(p.country)} · ${fmt.format(p.visits.length)} ${p.visits.length === 1 ? 'Besuch' : 'Besuche'}</p><ul>${list}</ul>`);
      m.addTo(g);
      for (const dx of [-360, 360]) {
        if ((dx < 0 && p.lng > 100) || (dx > 0 && p.lng < -100)) {
          const c = L.circleMarker([p.lat, p.lng + dx], m.options).addTo(g);
          c.bindTooltip(m.getTooltip().getContent(), { className: 'port-label', direction: 'top' });
        }
      }
      this.portLayers.push({ m, p });
    }
  }

  select(id, fit = true) {
    this.selected = id;
    const focus = document.getElementById('map-focus');
    for (const [cid, { group, style }] of this.routeLayers) {
      if (id == null) group.setStyle({ ...style });
      else if (cid === id) { group.setStyle({ color: this.colors.accent, weight: 4, opacity: 1 }); group.bringToFront(); }
      else group.setStyle({ opacity: 0.12, weight: 1.5 });
    }
    for (const { m, p } of this.portLayers) {
      const on = id == null || p.visits.some((v) => v.cruise?.id === id);
      m.setStyle({ fillOpacity: on ? 1 : 0.15, opacity: on ? 1 : 0.15 });
    }
    if (id == null) { focus.hidden = true; return; }
    const c = this.model.cruises.find((x) => x.id === id);
    if (!c) { focus.hidden = true; return; }
    focus.hidden = false;
    focus.innerHTML = `<b>${esc(c.ship)}</b>${esc(c.route)}<br><span class="muted">${fmtDate(c.start)} – ${fmtDate(c.end)} · ${c.nights} Nächte · ${fmt.format(Math.round(c.nm))} sm${c.captain ? ` · Kapitän ${esc(c.captain)}` : ''}</span><br><button class="text-btn" type="button">Alle Reisen zeigen</button>`;
    focus.querySelector('button').addEventListener('click', () => this.onSelectCruise(null));
    if (fit && c.legs.length) {
      const pts = unwrap(c.legs.map((s) => [s.lat, s.lng]));
      this.map.flyToBounds(pts, { padding: [48, 48], maxZoom: 6, duration: 0.8 });
    }
  }
}
