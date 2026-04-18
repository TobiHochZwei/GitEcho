// Sidebar collapse toggle for mobile. AdminLTE 4 uses [data-lte-toggle="sidebar"].
document.addEventListener('DOMContentLoaded', () => {
  const toggles = document.querySelectorAll('[data-lte-toggle="sidebar"]');
  toggles.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      document.body.classList.toggle('sidebar-open');
      document.body.classList.toggle('sidebar-collapsed');
    });
  });

  // Treeview toggles (sidebar Settings group)
  document
    .querySelectorAll('.sidebar-menu .nav-item > .nav-link')
    .forEach((link) => {
      const item = link.parentElement;
      if (!item || !item.querySelector(':scope > .nav-treeview')) return;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        item.classList.toggle('menu-open');
      });
    });

  // Close mobile sidebar when clicking outside it
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('sidebar-open')) return;
    const target = e.target as HTMLElement;
    if (target.closest('.app-sidebar') || target.closest('[data-lte-toggle="sidebar"]')) return;
    document.body.classList.remove('sidebar-open');
  });
});
