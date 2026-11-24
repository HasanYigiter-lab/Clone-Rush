/* GEÇİCİ TEŞHİS ARACI - Gem Rush beyaz ekran araştırması.
   Ekranın üstüne yeşil yazıyla durum/hata mesajları basar. Dokunmaları engellemez.
   Sorun çözülünce workflow'daki "Inject temporary diagnostic overlay" adımı silinir. */
(function () {
  var logs = [], box = null, t0 = Date.now();
  function ts() { return ((Date.now() - t0) / 1000).toFixed(1) + 's'; }
  function render() {
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;max-height:45%;overflow:hidden;' +
        'background:rgba(0,0,0,.88);color:#7CFC00;font:11px/1.35 monospace;padding:6px 8px;' +
        'white-space:pre-wrap;word-break:break-all;pointer-events:none';
      (document.body || document.documentElement).appendChild(box);
    }
    box.textContent = logs.join('\n');
  }
  function log(m) {
    logs.push('[' + ts() + '] ' + m);
    if (logs.length > 30) logs.shift();
    try { render(); } catch (e) {}
  }
  function s(v) { try { return typeof v === 'string' ? v : (v && v.stack) || (v && v.message) || JSON.stringify(v); } catch (e) { return String(v); } }

  log('1) HTML yuklendi, diag.js calisti');
  var m = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
  log('WebView Chrome surumu: ' + (m ? m[1] : 'bilinmiyor') + ' | ekran ' + innerWidth + 'x' + innerHeight);
  try { new Function('var a=null;return a?.b ?? 1'); log('JS ?. ve ?? destegi: VAR'); } catch (e) { log('JS ?. / ?? destegi: YOK (eski WebView!)'); }
  try { log('CSS aspect-ratio: ' + CSS.supports('aspect-ratio', '9/16') + ' | inset: ' + CSS.supports('inset', '0')); } catch (e) {}

  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window) { log('KAYNAK YUKLENEMEDI: ' + (e.target.src || e.target.href)); return; }
    log('HATA: ' + e.message + ' @' + String(e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno);
  }, true);
  window.addEventListener('unhandledrejection', function (e) { log('PROMISE HATASI: ' + s(e.reason).slice(0, 300)); });
  ['error', 'warn'].forEach(function (k) {
    var o = console[k];
    console[k] = function () {
      try { log('console.' + k + ': ' + Array.prototype.map.call(arguments, s).join(' ').slice(0, 300)); } catch (e) {}
      return o.apply(console, arguments);
    };
  });

  document.addEventListener('DOMContentLoaded', function () { log('2) DOM hazir'); });
  window.addEventListener('load', function () { log('3) Sayfa tamamen yuklendi'); });

  function status(tag) {
    var out = tag + ' ';
    try { out += 'Capacitor=' + (window.Capacitor ? (window.Capacitor.isNativePlatform ? window.Capacitor.isNativePlatform() : '?') : 'yok'); } catch (e) {}
    try { out += ' | GemRushAdMob=' + (typeof window.GemRushAdMob); } catch (e) {}
    try { out += ' | AdMob hazir=' + (window.GemRushAdMob && window.GemRushAdMob.isReady()); } catch (e) {}
    try { out += ' | oyun(G)=' + (typeof G); } catch (e) { out += ' | oyun(G)=HATA'; }
    try { out += ' | menu acik=' + document.getElementById('menu').classList.contains('on'); } catch (e) {}
    try { var c = document.getElementById('cv'); out += ' | canvas=' + c.width + 'x' + c.height; } catch (e) {}
    log(out);
  }
  setTimeout(function () { status('4) 1.5sn:'); }, 1500);
  setTimeout(function () { status('5) 5sn:'); }, 5000);
})();
