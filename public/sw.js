// TE-Slotwise – Service Worker: installierbare App, Offline-Hinweis und Push-Benachrichtigungen.
// Seiten mit persönlichen Daten werden bewusst NICHT zwischengespeichert – nur Gestaltung und Offline-Seite.
'use strict';

var CACHE = 'slotwise-v1';
var ASSETS = ['/offline.html', '/static/app.css', '/static/app.js', '/static/icon.svg', '/static/icon-192.png'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(function (c) {
        return c.addAll(ASSETS);
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) {
              return k !== CACHE;
            })
            .map(function (k) {
              return caches.delete(k);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Seiten: immer frisch aus dem Netz; ohne Verbindung die Offline-Seite.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match('/offline.html');
      }),
    );
    return;
  }
  // Gestaltung/Skripte: Netz zuerst, bei Ausfall aus dem Zwischenspeicher.
  if (url.pathname.indexOf('/static/') === 0) {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          if (res.ok) caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        })
        .catch(function () {
          return caches.match(req);
        }),
    );
  }
});

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'TE-Slotwise', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'TE-Slotwise', {
      body: data.body || '',
      icon: '/static/icon-192.png',
      badge: '/static/badge-96.png',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      data: { url: data.url || '/dashboard' },
      lang: 'de',
    }),
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = new URL((event.notification.data && event.notification.data.url) || '/dashboard', self.location.origin);
  if (target.origin !== self.location.origin) target = new URL('/dashboard', self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          return c.navigate(target.href).then(function (w) {
            return (w || c).focus();
          });
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});

// Der Browser hat das Abo erneuert (z. B. abgelaufen): neu beim Server melden.
self.addEventListener('pushsubscriptionchange', function (event) {
  var opts = event.oldSubscription && event.oldSubscription.options;
  if (!opts) return;
  event.waitUntil(
    self.registration.pushManager.subscribe(opts).then(function (sub) {
      return fetch('/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
    }),
  );
});
