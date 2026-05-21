/*
 * Service.AI door-designer embed loader.
 *
 * Drop one tag on any site (e.g. elevateddoors.com) to mount the OPENDC
 * door designer; submissions become a lead + draft quote in Service.AI.
 *
 *   <div id="serviceai-door-designer"></div>
 *   <script
 *     src="https://app.serviceai.example/embed/door-designer.js"
 *     data-api="https://api.serviceai.example"
 *     data-container="#serviceai-door-designer"></script>
 *
 * data-api       (optional) Service.AI API origin. Defaults to the origin
 *                this script is served from.
 * data-container (optional) CSS selector for the mount point. Defaults to
 *                "#serviceai-door-designer"; created if absent.
 * data-designer  (optional) override for the door-designer IIFE URL.
 */
(function () {
  var current =
    document.currentScript ||
    (function () {
      var s = document.getElementsByTagName('script');
      return s[s.length - 1];
    })();

  var apiBase = (current.getAttribute('data-api') || current.src.replace(/\/embed\/door-designer\.js.*$/, '')).replace(/\/$/, '');
  var selector = current.getAttribute('data-container') || '#serviceai-door-designer';
  var designerUrl =
    current.getAttribute('data-designer') ||
    'https://portal.opendc.ca/widget/opendc-door-designer.iife.js';
  var webhook = apiBase + '/api/v1/public/widget/quote-request';

  function ensureContainer() {
    var el = document.querySelector(selector);
    if (!el && selector === '#serviceai-door-designer') {
      el = document.createElement('div');
      el.id = 'serviceai-door-designer';
      current.parentNode.insertBefore(el, current);
    }
    return el;
  }

  function mount() {
    var el = ensureContainer();
    if (!el || !window.OpenDCDesigner) return;
    window.OpenDCDesigner.init({ container: el, quoteWebhook: webhook });
  }

  if (window.OpenDCDesigner) {
    mount();
    return;
  }
  var s = document.createElement('script');
  s.src = designerUrl;
  s.async = true;
  s.onload = mount;
  document.head.appendChild(s);
})();
