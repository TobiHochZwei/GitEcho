// Theme toggle: persists in localStorage, falls back to prefers-color-scheme.
// Sets data-bs-theme on <html> for Bootstrap 5 dark mode.
const KEY = 'gitecho.theme';

type Theme = 'light' | 'dark';

function preferred(): Theme {
  return 'dark';
}

function current(): Theme {
  const saved = localStorage.getItem(KEY) as Theme | null;
  return saved ?? preferred();
}

function apply(theme: Theme) {
  document.documentElement.setAttribute('data-bs-theme', theme);
  const icon = document.getElementById('theme-toggle-icon');
  if (icon) {
    icon.className = theme === 'dark' ? 'bi bi-moon-stars-fill fs-5' : 'bi bi-sun-fill fs-5';
  }
}

apply(current());

document.addEventListener('DOMContentLoaded', () => {
  apply(current());
  const btn = document.getElementById('theme-toggle');
  btn?.addEventListener('click', () => {
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, next);
    apply(next);
  });
});
