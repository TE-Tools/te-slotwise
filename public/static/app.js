// TE-Slotwise – kleine Verbesserungen im Browser. Alles funktioniert auch ohne JavaScript.
(function () {
  'use strict';

  // Link kopieren (mit Rückfall für ältere Browser).
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-copy');
      var input = document.getElementById(id);
      var status = document.querySelector('[data-copy-status="' + id + '"]');
      if (!input) return;
      var done = function () {
        if (status) status.textContent = 'Link kopiert.';
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(input.value).then(done, function () {
          input.select();
          if (status) status.textContent = 'Bitte mit Strg+C (bzw. ⌘+C) kopieren.';
        });
      } else {
        input.focus();
        input.select();
        try {
          document.execCommand('copy');
          done();
        } catch (e) {
          if (status) status.textContent = 'Bitte mit Strg+C (bzw. ⌘+C) kopieren.';
        }
      }
    });
  });

  // Teilen über das Betriebssystem (WhatsApp, E-Mail, Messenger …), wenn verfügbar.
  if (navigator.share) {
    document.querySelectorAll('[data-share-url]').forEach(function (btn) {
      btn.hidden = false;
      btn.addEventListener('click', function () {
        navigator
          .share({ title: btn.getAttribute('data-share-title') || 'TE-Slotwise', url: btn.getAttribute('data-share-url') })
          .catch(function () {});
      });
    });
  }

  // Rückfrage vor folgenreichen Aktionen.
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Auswahlfeld sendet Formular direkt ab (z. B. Rolle ändern).
  document.querySelectorAll('select[data-autosubmit]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      if (sel.form) sel.form.requestSubmit ? sel.form.requestSubmit() : sel.form.submit();
    });
  });

  // Alle Zeilen auswählen.
  document.querySelectorAll('[data-select-all]').forEach(function (box) {
    box.addEventListener('change', function () {
      var form = box.closest('form');
      if (!form) return;
      form.querySelectorAll('input[name="ids"]').forEach(function (cb) {
        cb.checked = box.checked;
      });
    });
  });

  // Zielgruppen-Auswahl nur zeigen, wenn sie gebraucht wird.
  document.querySelectorAll('select[data-visibility]').forEach(function (sel) {
    var form = sel.closest('form');
    var box = form && form.querySelector('[data-audience]');
    if (!box) return;
    var update = function () {
      box.hidden = !(sel.value === 'groups' || sel.value === 'people');
    };
    sel.addEventListener('change', update);
    update();
  });
  // „voll“: Preis eines Termins als bezahlten Betrag übernehmen.
  document.querySelectorAll('[data-fill-from]').forEach(function (btn) {
    var from = document.getElementById(btn.getAttribute('data-fill-from'));
    var to = document.getElementById(btn.getAttribute('data-fill-to'));
    if (!from || !to) return;
    btn.hidden = false;
    btn.addEventListener('click', function () {
      to.value = from.value;
      to.focus();
    });
  });

  // Wochenkalender auf schmalen Bildschirmen zum heutigen Tag scrollen.
  document.querySelectorAll('.week-scroll').forEach(function (box) {
    var today = box.querySelector('.week-dayhead.is-today');
    var axis = box.querySelector('.week-axis');
    if (!today || box.scrollWidth <= box.clientWidth) return;
    box.scrollLeft = Math.max(0, today.offsetLeft - (axis ? axis.offsetWidth : 0));
  });
  // ---------- Installierbare App (PWA) ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  var isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var installBtns = document.querySelectorAll('[data-install]');
  var deferredPrompt = null;
  var show = function (sel, on) {
    document.querySelectorAll(sel).forEach(function (el) {
      el.hidden = !on;
    });
  };
  if (standalone) show('[data-installed]', true);
  else if (isIos) show('[data-install-ios]', true);
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    show('[data-install]', true);
  });
  installBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(function () {
        deferredPrompt = null;
        show('[data-install]', false);
      });
    });
  });
  window.addEventListener('appinstalled', function () {
    show('[data-install]', false);
    show('[data-installed]', true);
  });

  // ---------- Push-Benachrichtigungen ----------
  var pushBox = document.querySelector('[data-push]');
  if (pushBox) {
    var status = pushBox.querySelector('[data-push-status]');
    var onBtn = pushBox.querySelector('[data-push-on]');
    var offBtn = pushBox.querySelector('[data-push-off]');
    var say = function (text) {
      status.textContent = text;
    };
    var keyBytes = function (b64) {
      var pad = '='.repeat((4 - (b64.length % 4)) % 4);
      var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
      var out = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    };
    var post = function (path, body) {
      return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) {
        if (!r.ok) throw new Error('Server ' + r.status);
      });
    };
    var render = function (sub) {
      onBtn.hidden = !!sub;
      offBtn.hidden = !sub;
      if (sub) say('Push ist auf diesem Gerät eingeschaltet.');
      else if (Notification.permission === 'denied') {
        say('Benachrichtigungen sind für diese Seite im Browser blockiert. Erlaube sie in den Website-Einstellungen und lade die Seite neu.');
        onBtn.hidden = true;
      } else say('Push ist auf diesem Gerät ausgeschaltet.');
    };
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      say(isIos && !standalone ? 'Auf dem iPhone/iPad zuerst die App installieren (siehe oben) und dann hier in der App Push einschalten.' : 'Dieser Browser unterstützt keine Push-Benachrichtigungen.');
    } else {
      navigator.serviceWorker.ready
        .then(function (reg) {
          return reg.pushManager.getSubscription().then(function (sub) {
            // Abo beim Server auffrischen (z. B. nach Anmeldung mit anderem Konto auf demselben Gerät).
            if (sub) post('/push/subscribe', sub.toJSON()).catch(function () {});
            render(sub);
            onBtn.addEventListener('click', function () {
              onBtn.disabled = true;
              say('Einen Moment …');
              Notification.requestPermission()
                .then(function (perm) {
                  if (perm !== 'granted') throw new Error('perm');
                  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushBox.getAttribute('data-push-key')) });
                })
                .then(function (s) {
                  return post('/push/subscribe', s.toJSON()).then(function () {
                    window.location.href = '/profile?msg=push_on#app';
                  });
                })
                .catch(function (e) {
                  onBtn.disabled = false;
                  if (e && e.message === 'perm') render(null);
                  else say('Push konnte nicht eingeschaltet werden. Bitte später erneut versuchen.');
                });
            });
            offBtn.addEventListener('click', function () {
              offBtn.disabled = true;
              reg.pushManager.getSubscription().then(function (s) {
                if (!s) return render(null);
                var endpoint = s.endpoint;
                return s.unsubscribe().then(function () {
                  return post('/push/unsubscribe', { endpoint: endpoint }).catch(function () {});
                }).then(function () {
                  window.location.reload();
                });
              });
            });
          });
        })
        .catch(function () {
          say('Push ist gerade nicht verfügbar.');
        });
    }
  }
  // ---------- Slots anlegen: Wiederholung und Vorschau ----------
  var slotForm = document.querySelector('form[data-slot-form]');
  if (slotForm) {
    var el = function (n) {
      return slotForm.querySelector('[name="' + n + '"]');
    };
    var repeatBox = slotForm.querySelector('[data-repeat-only]');
    var preview = slotForm.querySelector('[data-slot-preview]');
    var DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    var mins = function (v) {
      var m = /^(\d{2}):(\d{2})$/.exec(v || '');
      return m ? +m[1] * 60 + +m[2] : null;
    };
    var hhmm = function (m) {
      return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    };
    var isoWd = function (d) {
      var w = d.getUTCDay();
      return w === 0 ? 7 : w;
    };
    var parse = function (v) {
      return /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? new Date(v + 'T00:00:00Z') : null;
    };
    var fmt = function (d) {
      return String(d.getUTCDate()).padStart(2, '0') + '.' + String(d.getUTCMonth() + 1).padStart(2, '0') + '.' + d.getUTCFullYear();
    };
    var lastWd = null;
    var update = function () {
      var rep = (slotForm.querySelector('input[name="repeat"]:checked') || {}).value || 'once';
      if (repeatBox) repeatBox.hidden = rep === 'once';
      var from = parse(el('from').value);
      // Wochentag des gewählten Tages automatisch mitwählen.
      if (from) {
        var wd = isoWd(from);
        if (wd !== lastWd) {
          if (lastWd) {
            var old = slotForm.querySelector('[data-weekday="' + lastWd + '"]');
            if (old) old.checked = false;
          }
          var cur = slotForm.querySelector('[data-weekday="' + wd + '"]');
          if (cur) cur.checked = true;
          lastWd = wd;
        }
      }
      var offEl = el('offering_id');
      var opt = offEl && offEl.tagName === 'SELECT' ? offEl.options[offEl.selectedIndex] : offEl;
      var custom = parseInt((el('duration') || {}).value, 10);
      var dur = custom > 0 ? custom : parseInt(opt && opt.getAttribute('data-duration'), 10);
      var buf = parseInt((el('buffer_min') || {}).value, 10);
      if (!(buf >= 0)) buf = parseInt(opt && opt.getAttribute('data-buffer'), 10) || 0;
      var s = mins(el('window_start').value);
      var e = mins(el('window_end').value);
      if (!from || s === null || e === null || !dur) return;
      if (e - s < dur) {
        preview.textContent = 'Die Zeitspanne ist kürzer als ein Termin (' + dur + ' Min.). Bitte „Bis“ später wählen.';
        return;
      }
      var times = [];
      for (var t = s; t + dur <= e; t += dur + buf) times.push(hhmm(t));
      var dates = [];
      if (rep === 'once') dates.push(from);
      else {
        var every = rep === 'biweekly' ? 2 : 1;
        var until = parse(el('until').value);
        var end = until || new Date(from.getTime() + (parseInt(el('weeks').value, 10) * 7 - 1) * 86400000);
        var wds = Array.prototype.map.call(slotForm.querySelectorAll('input[name="weekday"]:checked'), function (c) {
          return +c.value;
        });
        if (wds.indexOf(isoWd(from)) < 0) wds.push(isoWd(from));
        var monday = new Date(from.getTime() - (isoWd(from) - 1) * 86400000);
        for (var d = new Date(from); d <= end && dates.length < 600; d = new Date(d.getTime() + 86400000)) {
          var week = Math.floor((d - monday) / (7 * 86400000));
          if (wds.indexOf(isoWd(d)) >= 0 && week % every === 0) dates.push(d);
        }
      }
      var n = dates.length * times.length;
      var dayNames = [];
      dates.forEach(function (d) {
        var name = DAYS[isoWd(d) - 1];
        if (dayNames.indexOf(name) < 0) dayNames.push(name);
      });
      preview.textContent =
        'Ergibt ' + n + (n === 1 ? ' Termin' : ' Termine') + ': ' +
        (times.length > 4 ? times.length + ' pro Tag ab ' + times[0] : times.join(', ')) + ' Uhr (je ' + dur + ' Min.)' +
        (dates.length > 1 ? ', ' + dayNames.join(' + ') + ' vom ' + fmt(dates[0]) + ' bis ' + fmt(dates[dates.length - 1]) : ' am ' + fmt(dates[0] || from)) +
        '. Vorhandene Slots werden übersprungen.';
    };
    slotForm.addEventListener('input', update);
    slotForm.addEventListener('change', update);
    update();
  }
})();
