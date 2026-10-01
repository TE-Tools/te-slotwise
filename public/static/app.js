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
})();
