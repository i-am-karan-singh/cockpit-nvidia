// Match the shell theme signal used by Cockpit's own pages.
function setTheme(style) {
  const choice = style || localStorage.getItem('shell:style') || 'auto';
  const dark = choice === 'dark' || (choice === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('pf-v6-theme-dark', dark);
}
window.addEventListener('storage', event => { if (event.key === 'shell:style') setTheme(); });
window.addEventListener('cockpit-style', event => { if (event.detail?.style) setTheme(event.detail.style); });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTheme());
setTheme();
