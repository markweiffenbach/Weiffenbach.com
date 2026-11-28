// Häfen-Übersicht: Suche nach Hafen oder Land, blendet leere Kontinente aus
(() => {
  const q = document.getElementById('q');
  if (!q) return;
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  q.addEventListener('input', () => {
    const t = norm(q.value.trim());
    document.querySelectorAll('.continent').forEach((sec) => {
      let n = 0;
      sec.querySelectorAll('.port-card').forEach((a) => { const hit = !t || norm(a.textContent).includes(t); a.hidden = !hit; if (hit) n++; });
      sec.hidden = !n;
    });
  });
})();
