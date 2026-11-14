// Applies the saved theme before the first paint. A separate file rather than
// an inline script so the Content Security Policy can forbid inline code.
try {
  var saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch (e) { /* storage blocked: follow the system theme */ }
