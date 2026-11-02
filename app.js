'use strict';

/* =====================================================================
   Sürüş Asistanı — iPhone Safari (iOS 16+) için PWA/web uygulaması
   Sensörler : Konum/GPS (hız, mesafe, yön) + Pusula (DeviceOrientation)
   Veri      : Open-Meteo (hava, anahtarsız), TomTom Traffic API (trafik)
   ===================================================================== */

const RADIUS_M = 5000;                 // trafik yarıçapı
const TRAFFIC_REFRESH_MS = 90 * 1000;  // sürüş sırasında trafik yenileme
const GPS_HEADING_MIN_SPEED = 2;       // m/s (~7 km/s) üstünde yön GPS'ten alınır
const MAX_ACCURACY_M = 50;             // bundan kötü GPS noktaları mesafeye eklenmez

const state = {
  pos: null,               // {lat, lon, acc}
  compassOk: false,
  compassHeading: null,
  gpsHeading: null,
  speedMs: 0,
  distanceM: 0,
  lastPoint: null,         // mesafe hesabı için son kabul edilen nokta {lat, lon, t}
  prevFix: null,           // hız yedek hesabı için
  lastFixAt: 0,
  watchId: null,
  driving: false,
  shownHeading: null,
  trafficKey: '',
  trafficTimer: null,
  trafficBusy: false,
  wakeLock: null,
  statusTimer: null,
};

/* ---------------------------- Yardımcılar ---------------------------- */
const $ = (id) => document.getElementById(id);
const toRad = (d) => (d * Math.PI) / 180;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Merkez noktasının, [lon,lat] çizgisine/noktasına en kısa mesafesi (metre)
function minDistanceToGeometry(lat0, lon0, geom) {
  if (!geom || !Array.isArray(geom.coordinates)) return Infinity;
  const pts = geom.type === 'Point' ? [geom.coordinates] : geom.coordinates;
  if (!pts.length) return Infinity;
  const kx = 111320 * Math.cos(toRad(lat0));
  const ky = 111320;
  const P = pts.map((p) => [(p[0] - lon0) * kx, (p[1] - lat0) * ky]);
  if (P.length === 1) return Math.hypot(P[0][0], P[0][1]);
  let min = Infinity;
  for (let i = 0; i < P.length - 1; i++) {
    const A = P[i], B = P[i + 1];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, (-A[0] * dx - A[1] * dy) / len2)) : 0;
    min = Math.min(min, Math.hypot(A[0] + t * dx, A[1] + t * dy));
  }
  return min;
}

const CARD16 = ['K','KKD','KD','DKD','D','DGD','GD','GGD','G','GGB','GB','BGB','B','BKB','KB','KKB'];
const NAME8 = ['Kuzey','Kuzeydoğu','Doğu','Güneydoğu','Güney','Güneybatı','Batı','Kuzeybatı'];
const cardinal16 = (deg) => CARD16[Math.round(deg / 22.5) % 16];
const name8 = (deg) => NAME8[Math.round(deg / 45) % 8];

function storageGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* yoksay */ } }

function showScreen(id) {
  ['screen-permission', 'screen-prep', 'screen-drive'].forEach((s) => { $(s).hidden = (s !== id); });
  window.scrollTo(0, 0);
}

/* ------------------------------ İzinler ------------------------------ */
function getPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject,
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}

function onOrientation(e) {
  // iOS Safari: webkitCompassHeading = manyetik kuzeyden saat yönünde derece
  const h = e.webkitCompassHeading;
  if (typeof h === 'number' && !Number.isNaN(h) && h >= 0) {
    state.compassHeading = h;
    state.compassOk = true;
  }
}

function waitForCompass(ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (state.compassOk) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(false); }
    }, 100);
  });
}

function permLine(text, cls) {
  $('perm-list').append(el('li', cls, text));
}

function permFail(msg) {
  const e = $('perm-error');
  e.textContent = msg;
  e.hidden = false;
  $('btn-grant').disabled = false;
}

async function requestPermissions() {
  const btn = $('btn-grant');
  btn.disabled = true;
  $('perm-error').hidden = true;
  $('perm-list').replaceChildren();

  if (!window.isSecureContext || !('geolocation' in navigator)) {
    permFail('Bu sayfa HTTPS üzerinden (ör. GitHub Pages) Safari ile açılmalıdır.');
    return;
  }

  // TomTom anahtarı
  state.trafficKey = $('tt-key').value.trim();
  storageSet('tt-key', state.trafficKey);

  // 1) Hareket/yön izni — kullanıcı dokunuşunun içinde, ilk işlem olarak istenmeli (iOS kuralı)
  let motionGranted = true;
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    try {
      motionGranted = (await DOE.requestPermission()) === 'granted';
    } catch (e) {
      motionGranted = false;
    }
  }

  // 2) Konum izni (zorunlu: hız, mesafe, hava, trafik buna bağlı)
  let first;
  try {
    first = await getPosition();
  } catch (e) {
    if (e && e.code === 1) {
      permFail('Konum izni verilmedi. Ayarlar › Gizlilik ve Güvenlik › Konum Servisleri › Safari Web Siteleri bölümünden "Uygulamayı Kullanırken" seçin, sayfayı yenileyip tekrar deneyin.');
    } else {
      permFail('Konum alınamadı. Açık havada olduğunuzdan ve Konum Servisleri\'nin açık olduğundan emin olup tekrar deneyin.');
    }
    return;
  }
  state.pos = { lat: first.coords.latitude, lon: first.coords.longitude, acc: first.coords.accuracy };
  permLine('✅ Konum (GPS) çalışıyor');

  // 3) Pusula: gerçekten veri geliyor mu?
  if (motionGranted) {
    window.addEventListener('deviceorientation', onOrientation);
    state.compassOk = false;
    const ok = await waitForCompass(3000);
    if (ok) permLine('✅ Pusula çalışıyor');
    else permLine('⚠️ Pusula verisi gelmiyor. Yön, yalnızca hareket halindeyken GPS\'ten gösterilecek.', 'warn');
  } else {
    permLine('⚠️ Hareket/yön izni verilmedi. Yön, yalnızca hareket halindeyken GPS\'ten gösterilecek. (Pusulayı açmak için Safari\'yi tamamen kapatıp yeniden açın.)', 'warn');
  }

  enterPrep();
}

/* ------------------------- Hava durumu (Open-Meteo) ------------------------- */
const WMO = {
  0: ['Açık', '☀️'], 1: ['Çoğunlukla açık', '🌤️'], 2: ['Parçalı bulutlu', '⛅'], 3: ['Kapalı', '☁️'],
  45: ['Sisli', '🌫️'], 48: ['Kırağılı sis', '🌫️'],
  51: ['Hafif çise', '🌦️'], 53: ['Çise', '🌦️'], 55: ['Yoğun çise', '🌧️'],
  56: ['Dondurucu çise', '🌧️'], 57: ['Dondurucu çise', '🌧️'],
  61: ['Hafif yağmur', '🌦️'], 63: ['Yağmur', '🌧️'], 65: ['Şiddetli yağmur', '🌧️'],
  66: ['Dondurucu yağmur', '🌧️'], 67: ['Dondurucu yağmur', '🌧️'],
  71: ['Hafif kar', '🌨️'], 73: ['Kar', '🌨️'], 75: ['Yoğun kar', '❄️'], 77: ['Kar taneleri', '❄️'],
  80: ['Hafif sağanak', '🌦️'], 81: ['Sağanak', '🌧️'], 82: ['Şiddetli sağanak', '⛈️'],
  85: ['Hafif kar sağanağı', '🌨️'], 86: ['Kar sağanağı', '❄️'],
  95: ['Gök gürültülü fırtına', '⛈️'], 96: ['Dolulu fırtına', '⛈️'], 99: ['Şiddetli dolulu fırtına', '⛈️'],
};
const wmo = (c) => WMO[c] || ['Bilinmiyor', '❔'];

async function loadWeather() {
  const body = $('weather-body');
  body.replaceChildren(el('p', 'muted', 'Yükleniyor…'));
  try {
    const { lat, lon } = state.pos;
    const url = 'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m' +
      '&hourly=temperature_2m,precipitation_probability,weather_code,wind_gusts_10m' +
      '&forecast_days=2&timezone=auto&wind_speed_unit=kmh';
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    renderWeather(d);
  } catch (e) {
    body.replaceChildren(el('p', 'error', 'Hava durumu alınamadı. İnternet bağlantınızı kontrol edin.'));
    const b = el('button', 'mini', 'Tekrar dene');
    b.type = 'button';
    b.addEventListener('click', loadWeather);
    body.append(b);
  }
}

function renderWeather(d) {
  const body = $('weather-body');
  const c = d.current;
  const [desc, icon] = wmo(c.weather_code);

  // Bir sonraki 6 saat
  const H = d.hourly;
  const hours = [];
  for (let i = 0; i < H.time.length && hours.length < 6; i++) {
    if (H.time[i] > c.time) {
      hours.push({
        time: H.time[i].slice(11, 16),
        temp: H.temperature_2m[i],
        pop: H.precipitation_probability[i],
        code: H.weather_code[i],
        gust: H.wind_gusts_10m[i],
      });
    }
  }

  // Sürücü uyarıları
  const warns = [];
  const codes = [c.weather_code, ...hours.map((h) => h.code)];
  const temps = [c.temperature_2m, ...hours.map((h) => h.temp)];
  const gusts = [c.wind_gusts_10m, ...hours.map((h) => h.gust)];
  const maxPop = Math.max(0, ...hours.map((h) => h.pop || 0));
  if (codes.some((x) => x === 45 || x === 48)) warns.push('Sis var: görüş mesafesi düşebilir, takip mesafesini artırın.');
  if (codes.some((x) => (x >= 71 && x <= 77) || x === 85 || x === 86)) warns.push('Kar bekleniyor: yol kaygan olabilir, kış lastiği/zincir gerekebilir.');
  if (codes.some((x) => x === 56 || x === 57 || x === 66 || x === 67)) warns.push('Dondurucu yağış: yolda buzlanma riski yüksek.');
  else if (Math.min(...temps) <= 3 && maxPop >= 30) warns.push('Sıcaklık düşük ve yağış ihtimali var: buzlanma riski.');
  if (codes.some((x) => x >= 95)) warns.push('Gök gürültülü fırtına ihtimali var.');
  else if (maxPop >= 60 || c.precipitation > 0) warns.push('Yağış bekleniyor: yol kayganlaşabilir, hızınızı azaltın.');
  if (Math.max(...gusts) >= 60) warns.push('Kuvvetli rüzgâr (' + Math.round(Math.max(...gusts)) + ' km/s esinti) bekleniyor.');

  const now = el('div', 'wx-now');
  now.append(el('div', 'wx-icon', icon));
  const t = el('div');
  t.append(el('div', 'wx-temp', Math.round(c.temperature_2m) + '°C'), el('div', 'wx-desc', desc));
  now.append(t);

  const meta = el('div', 'wx-meta');
  meta.append(
    el('div', null, 'Hissedilen: ' + Math.round(c.apparent_temperature) + '°C'),
    el('div', null, 'Nem: %' + Math.round(c.relative_humidity_2m)),
    el('div', null, 'Rüzgâr: ' + Math.round(c.wind_speed_10m) + ' km/s'),
    el('div', null, 'Esinti: ' + Math.round(c.wind_gusts_10m) + ' km/s'),
  );

  const strip = el('div', 'wx-hours');
  hours.forEach((h) => {
    const box = el('div', 'wx-hour');
    box.append(
      el('div', 't', h.time),
      el('div', 'i', wmo(h.code)[1]),
      el('div', null, Math.round(h.temp) + '°'),
      el('div', 'p', '💧%' + (h.pop == null ? 0 : h.pop)),
    );
    strip.append(box);
  });

  body.replaceChildren(now, meta, strip);
  if (warns.length) {
    const ul = el('ul', 'warns');
    warns.forEach((w) => ul.append(el('li', null, '⚠️ ' + w)));
    body.append(ul);
  }
  $('weather-place').textContent = 'Konumunuz · ' + state.pos.lat.toFixed(3) + ', ' + state.pos.lon.toFixed(3);
}

/* ------------------------- Trafik (TomTom) ------------------------- */
const CATEGORY = {
  0: ['Olay', '❗'], 1: ['Kaza', '💥'], 2: ['Sis', '🌫️'], 3: ['Tehlikeli koşul', '⚠️'],
  4: ['Yağmur', '🌧️'], 5: ['Buzlanma', '🧊'], 6: ['Trafik yoğunluğu', '🚗'], 7: ['Şerit kapalı', '🚧'],
  8: ['Yol kapalı', '⛔'], 9: ['Yol çalışması', '🚧'], 10: ['Rüzgâr', '💨'], 11: ['Sel', '🌊'],
  14: ['Arızalı araç', '🛠️'],
};
const SEVERITY = { 0: '', 1: 'Hafif', 2: 'Orta', 3: 'Ağır', 4: 'Kapalı' };

function trafficErrorText(status) {
  if (status === 401 || status === 403) return 'TomTom anahtarı geçersiz veya bu alan adı için yetkisiz.';
  if (status === 429) return 'TomTom günlük istek sınırı doldu.';
  return 'Trafik verisi alınamadı (HTTP ' + status + ').';
}

async function fetchIncidents(lat, lon) {
  const dLat = RADIUS_M / 111320;
  const dLon = RADIUS_M / (111320 * Math.cos(toRad(lat)));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((n) => n.toFixed(5)).join(',');
  const fields = '{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,from,to,length,delay,roadNumbers}}}';
  const url = 'https://api.tomtom.com/traffic/services/5/incidentDetails' +
    `?key=${encodeURIComponent(state.trafficKey)}&bbox=${bbox}` +
    `&fields=${encodeURIComponent(fields)}&language=en-GB&timeValidityFilter=present`;
  const r = await fetch(url);
  if (!r.ok) { const e = new Error('http'); e.status = r.status; throw e; }
  const data = await r.json();
  const items = [];
  (data.incidents || []).forEach((inc) => {
    const p = inc.properties || {};
    const dist = minDistanceToGeometry(lat, lon, inc.geometry);
    if (dist <= RADIUS_M) items.push({ p, dist });
  });
  items.sort((a, b) => {
    const ja = a.p.iconCategory === 6 ? 0 : 1, jb = b.p.iconCategory === 6 ? 0 : 1;
    if (ja !== jb) return ja - jb;
    const ma = a.p.magnitudeOfDelay || 0, mb = b.p.magnitudeOfDelay || 0;
    if (ma !== mb) return mb - ma;
    return a.dist - b.dist;
  });
  return items;
}

async function fetchFlow(lat, lon) {
  const url = 'https://api.tomtom.com/traffic/services/4/flowSegmentData/relative0/10/json' +
    `?key=${encodeURIComponent(state.trafficKey)}&point=${lat.toFixed(5)},${lon.toFixed(5)}&unit=KMPH`;
  const r = await fetch(url);
  if (!r.ok) { const e = new Error('http'); e.status = r.status; throw e; }
  const d = await r.json();
  const f = d.flowSegmentData;
  if (!f || !f.freeFlowSpeed) throw new Error('no flow');
  return f;
}

async function loadTraffic() {
  if (!state.trafficKey || !state.pos || state.trafficBusy) return;
  state.trafficBusy = true;
  const { lat, lon } = state.pos;
  const [inc, flow] = await Promise.allSettled([fetchIncidents(lat, lon), fetchFlow(lat, lon)]);
  state.trafficBusy = false;
  renderTraffic(inc, flow);
}

function renderTraffic(inc, flow) {
  document.querySelectorAll('.traffic-body').forEach((box) => {
    box.replaceChildren();

    if (inc.status === 'rejected' && flow.status === 'rejected') {
      const st = inc.reason && inc.reason.status;
      box.append(el('p', 'error', st ? trafficErrorText(st) : 'Trafik verisi alınamadı (bağlantı hatası).'));
      return;
    }

    if (flow.status === 'fulfilled') {
      const f = flow.value;
      const ratio = f.currentSpeed / f.freeFlowSpeed;
      let label = 'Akıcı', cls = 'f-ok';
      if (f.roadClosure) { label = 'Yol kapalı'; cls = 'f-bad'; }
      else if (ratio < 0.35) { label = 'Çok yoğun'; cls = 'f-bad'; }
      else if (ratio < 0.6) { label = 'Yoğun'; cls = 'f-bad'; }
      else if (ratio < 0.85) { label = 'Orta yoğun'; cls = 'f-mid'; }
      const d = el('div', 'flow');
      const b = el('b', cls, label);
      d.append('Bulunduğunuz yol: ', b,
        ` — ${Math.round(f.currentSpeed)} km/s (serbest akışta ${Math.round(f.freeFlowSpeed)} km/s)`);
      box.append(d);
    }

    if (inc.status === 'fulfilled') {
      const items = inc.value;
      if (!items.length) {
        box.append(el('p', 'ok', '5 km çevrede bildirilmiş trafik yoğunluğu veya olay yok.'));
      } else {
        const ul = el('ul', 'tlist');
        items.slice(0, 15).forEach(({ p, dist }) => {
          const [label, icon] = CATEGORY[p.iconCategory] || CATEGORY[0];
          const mag = p.magnitudeOfDelay || 0;
          const li = el('li', 's' + mag);
          const ttl = el('div', 'ttl');
          ttl.append(el('span', null, icon + ' ' + label));
          if (SEVERITY[mag]) ttl.append(el('span', 'badge', SEVERITY[mag]));
          li.append(ttl);

          let road = '';
          if (p.from && p.to) road = p.from + ' → ' + p.to;
          else road = p.from || p.to || 'Konum bilgisi yok';
          if (Array.isArray(p.roadNumbers) && p.roadNumbers.length) road = p.roadNumbers.join(', ') + ' · ' + road;
          li.append(el('div', 'road', road));

          const meta = [(dist / 1000).toFixed(1) + ' km uzakta'];
          if (p.delay > 0) meta.push(Math.round(p.delay / 60) + ' dk gecikme');
          if (p.length > 0) meta.push((p.length >= 1000 ? (p.length / 1000).toFixed(1) + ' km' : Math.round(p.length) + ' m') + ' uzunluk');
          li.append(el('div', 'meta', meta.join(' · ')));
          ul.append(li);
        });
        box.append(ul);
        if (items.length > 15) box.append(el('p', 'muted', `+${items.length - 15} kayıt daha var.`));
      }
    } else if (inc.status === 'rejected') {
      box.append(el('p', 'error', inc.reason && inc.reason.status ? trafficErrorText(inc.reason.status) : 'Olay verisi alınamadı.'));
    }
  });
}

function setupTrafficCards() {
  const on = !!state.trafficKey;
  document.querySelectorAll('.traffic-card').forEach((c) => { c.hidden = !on; });
}

/* ------------------------- Sürüş öncesi ekran ------------------------- */
function enterPrep() {
  showScreen('screen-prep');
  setupTrafficCards();
  loadWeather();
  loadTraffic();
}

/* ----------------------------- Sürüş ----------------------------- */
function onPosition(p) {
  const c = p.coords;
  const now = p.timestamp || Date.now();
  state.pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy };
  state.lastFixAt = Date.now();

  // Hız (m/s): önce cihazın verdiği, yoksa ardışık noktalardan
  let v = (typeof c.speed === 'number' && c.speed >= 0) ? c.speed : null;
  if (v === null && state.prevFix) {
    const dt = (now - state.prevFix.t) / 1000;
    if (dt > 0.5) v = haversine(state.prevFix.lat, state.prevFix.lon, c.latitude, c.longitude) / dt;
  }
  state.prevFix = { lat: c.latitude, lon: c.longitude, t: now };
  state.speedMs = (v == null || v < 0.5) ? 0 : v;

  // GPS yönü (hareket halinde geçerli)
  state.gpsHeading = (typeof c.heading === 'number' && !Number.isNaN(c.heading) && c.heading >= 0) ? c.heading : null;

  // Mesafe
  if (c.accuracy <= MAX_ACCURACY_M) {
    if (!state.lastPoint) {
      state.lastPoint = { lat: c.latitude, lon: c.longitude, t: now };
    } else {
      const d = haversine(state.lastPoint.lat, state.lastPoint.lon, c.latitude, c.longitude);
      const dt = Math.max((now - state.lastPoint.t) / 1000, 0.001);
      const threshold = Math.max(3, Math.min(c.accuracy * 0.5, 15)); // durağan GPS titremesini ele
      if (d >= threshold && d / dt <= 83) { // 300 km/s üstü sıçramaları ele
        state.distanceM += d;
        state.lastPoint = { lat: c.latitude, lon: c.longitude, t: now };
      }
    }
  }

  $('speed').textContent = String(Math.round(state.speedMs * 3.6));
  $('distance').textContent = (state.distanceM / 1000).toFixed(2);
}

function onPositionError(err) {
  const s = $('gps-status');
  s.textContent = err && err.code === 1 ? 'GPS: izin yok' : 'GPS: sinyal yok';
}

function currentHeading() {
  if (state.speedMs >= GPS_HEADING_MIN_SPEED && state.gpsHeading != null) return { deg: state.gpsHeading, src: 'GPS yönü' };
  if (state.compassOk && state.compassHeading != null) return { deg: state.compassHeading, src: 'Pusula' };
  return null;
}

function frame() {
  if (!state.driving) return;
  const h = currentHeading();
  if (h) {
    if (state.shownHeading == null) state.shownHeading = h.deg;
    const diff = ((h.deg - state.shownHeading + 540) % 360) - 180;
    state.shownHeading = (state.shownHeading + diff * 0.2 + 360) % 360;
    const deg = state.shownHeading;
    $('dial').setAttribute('transform', `rotate(${-deg} 100 100)`);
    $('heading-card').textContent = cardinal16(deg);
    $('heading-deg').textContent = Math.round(deg) % 360 + '°';
    $('heading-name').textContent = name8(deg);
    $('heading-src').textContent = h.src;
  } else {
    $('heading-card').textContent = '—';
    $('heading-deg').textContent = '—';
    $('heading-name').textContent = 'Hareket edince GPS yönü gösterilir';
    $('heading-src').textContent = '';
  }
  requestAnimationFrame(frame);
}

function updateGpsStatus() {
  const s = $('gps-status');
  if (!state.lastFixAt || Date.now() - state.lastFixAt > 10000) {
    s.textContent = 'GPS: sinyal bekleniyor…';
  } else {
    s.textContent = 'GPS: ±' + Math.round(state.pos.acc) + ' m';
  }
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* ekran kilidi engellenemedi; sessizce geç */ }
}

function startDrive() {
  state.driving = true;
  state.distanceM = 0;
  state.lastPoint = null;
  state.prevFix = null;
  state.speedMs = 0;
  state.shownHeading = null;
  state.lastFixAt = 0;
  $('speed').textContent = '0';
  $('distance').textContent = '0.00';

  showScreen('screen-drive');
  setupTrafficCards();
  buildDial();

  state.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError,
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  state.statusTimer = setInterval(updateGpsStatus, 1000);
  acquireWakeLock();
  requestAnimationFrame(frame);

  loadTraffic();
  state.trafficTimer = setInterval(loadTraffic, TRAFFIC_REFRESH_MS);
}

function stopDrive() {
  state.driving = false;
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  clearInterval(state.trafficTimer);
  clearInterval(state.statusTimer);
  if (state.wakeLock) { try { state.wakeLock.release(); } catch (e) { /* yoksay */ } state.wakeLock = null; }

  const km = (state.distanceM / 1000).toFixed(2);
  const lt = $('last-trip');
  lt.textContent = `Son sürüş: ${km} km`;
  lt.hidden = false;

  showScreen('screen-prep');
  setupTrafficCards();
  loadWeather();
  loadTraffic();
}

/* ------------------------------ Pusula kadranı ------------------------------ */
function buildDial() {
  const g = $('dial');
  if (g.childNodes.length) return;
  const NS = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 12; i++) {
    const ln = document.createElementNS(NS, 'line');
    const major = i % 3 === 0;
    ln.setAttribute('x1', '100'); ln.setAttribute('x2', '100');
    ln.setAttribute('y1', '10'); ln.setAttribute('y2', major ? '22' : '17');
    ln.setAttribute('transform', `rotate(${i * 30} 100 100)`);
    g.append(ln);
  }
  [['K', 100, 38, 'n'], ['D', 162, 100, ''], ['G', 100, 162, ''], ['B', 38, 100, '']].forEach(([t, x, y, cls]) => {
    const tx = document.createElementNS(NS, 'text');
    tx.setAttribute('x', x); tx.setAttribute('y', y);
    if (cls) tx.setAttribute('class', cls);
    tx.textContent = t;
    g.append(tx);
  });
}

/* ------------------------------ Başlangıç ------------------------------ */
$('tt-key').value = storageGet('tt-key');
$('btn-grant').addEventListener('click', requestPermissions);
$('btn-start').addEventListener('click', startDrive);
$('btn-stop').addEventListener('click', stopDrive);
$('btn-reset').addEventListener('click', () => {
  state.distanceM = 0;
  state.lastPoint = null;
  $('distance').textContent = '0.00';
});
document.querySelectorAll('.btn-refresh').forEach((b) => b.addEventListener('click', loadTraffic));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.driving) acquireWakeLock();
});