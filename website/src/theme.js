(() => {
  const root = document.documentElement;
  try {
    if (localStorage.getItem("synapse-theme") === "light") root.dataset.theme = "light";
  } catch {
    // Theme switching still works when browser storage is unavailable.
  }
  document.addEventListener("click", (event) => {
    if (!event.target.closest("[data-toggle-theme]")) return;
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    try {
      localStorage.setItem("synapse-theme", root.dataset.theme);
    } catch {
      // The chosen theme lasts for this page when storage is unavailable.
    }
  });
})();
