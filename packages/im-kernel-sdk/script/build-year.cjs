// Upstream's banner reads the current year. Freeze that build input without
// modifying the preserved upstream script or the product runtime clock.
Date.prototype.getFullYear = function () {
  return 2026
}
