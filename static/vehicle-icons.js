/* Shared top-down artwork. Rotate the inner image, never Leaflet's positioning element. */
(() => {
  "use strict";
  const base = new URL("vehicles/", document.currentScript.src);
  const headings = new WeakMap();
  const escape = value => String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  function html(type, label, color) {
    const vehicle = ["ambulance", "fire", "police"].includes(type) ? type : "ambulance";
    return `<span class="vehicle-shell" style="--vehicle-color:${color}" role="img" aria-label="${escape(label)}"><img class="vehicle-art" src="${new URL(vehicle + ".svg", base).href}" alt="" draggable="false"></span>`;
  }
  function face(marker, from, to) {
    const north = to[0] - from[0], east = (to[1] - from[1]) * Math.cos((from[0] + to[0]) * Math.PI / 360);
    if (Math.abs(north) + Math.abs(east) < 1e-10) return;
    const bearing = Math.atan2(east, north) * 180 / Math.PI;
    const previous = headings.get(marker) ?? bearing;
    const heading = previous + ((bearing - previous + 540) % 360 + 360) % 360 - 180;
    headings.set(marker, heading);
    const element = marker.getElement(), image = element?.querySelector(".vehicle-art");
    if (image) image.style.transform = `rotate(${heading}deg)`;
    if (element) element.dataset.heading = String(heading);
  }
  function setPosition(marker, position) {
    const old = marker.getLatLng();
    marker.setLatLng(position);
    face(marker, [old.lat, old.lng], position);
  }
  window.vehicleIcons = {html, face, setPosition};
})();
