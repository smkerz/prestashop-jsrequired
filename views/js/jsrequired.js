/*!
 * jsrequired - Payment widget blocker detector for PrestaShop 1.7
 * Version: 2.9.7
 *
 * Detects when payment widgets (Revolut / Stripe / PayPal via PrestaShop Checkout) fail to render
 * due to script/iframe blockers (NoScript, adblockers, anti-trackers) or CSP restrictions,
 * and displays a warning banner + inline warning near the payment option. It can also disable
 * the order confirmation button while the widget is missing.
 */
(function () {
  'use strict';

  var VERSION = '2.9.10';
  var cfg = window.jsrequiredConfig || {};

  // Back office options (injected via Media::addJsDef)
  var SHOW_BANNER = (typeof window.jsrequiredShowBanner !== 'undefined') ? !!window.jsrequiredShowBanner : true;
  var SHOW_INLINE = (typeof window.jsrequiredShowInline !== 'undefined') ? !!window.jsrequiredShowInline : true;
  var WHATSAPP_URL = (typeof window.jsrequiredWhatsAppUrl !== 'undefined') ? String(window.jsrequiredWhatsAppUrl || '') : '';
  var DEBUG = (typeof window.jsrequiredDebug !== 'undefined') ? !!window.jsrequiredDebug : !!cfg.debug;
  var DIAG_URL = (typeof window.jsrequiredDiagUrl === 'string') ? window.jsrequiredDiagUrl : '';
  var DIAG_TOKEN = (typeof window.jsrequiredDiagToken === 'string') ? window.jsrequiredDiagToken : '';

  // Message text can come from PHP injected var, config, or banner DOM.
  var fallbackMessage = (typeof window.jsrequiredBlockerMessage === 'string' && window.jsrequiredBlockerMessage) ||
    (typeof cfg.message === 'string' && cfg.message) ||
    "Le paiement ne peut pas s’afficher : votre navigateur/extension (NoScript, AdBlock, anti‑tracker) ou une règle de sécurité (CSP) bloque des scripts/iframes nécessaires au paiement (Revolut / Stripe / PayPal). Autorisez-les puis rechargez la page.";

  function normalizeProviderForMessage(provider) {
    if (!provider) return 'blank';
    // We treat braintreegateway as PayPal (commonly used by PayPal/Braintree modules).
    if (provider === 'braintreegateway') return 'paypal';
    return provider;
  }

  function buildContextMessage(provider) {
    var p = normalizeProviderForMessage(provider);
    var tail = " : votre navigateur/extension (NoScript, AdBlock, anti‑tracker) ou une règle de sécurité (CSP) bloque des scripts/iframes nécessaires au paiement";
    var suffix = ". Autorisez-les puis rechargez la page.";

    switch (p) {
      case 'paypal':
        return "PayPal ne peut pas se charger" + tail + " (PayPal)" + suffix;
      case 'stripe':
        return "Le champ carte Stripe ne s’affiche pas" + tail + " (Stripe)" + suffix;
      case 'revolut':
        return "Le champ carte Revolut ne s’affiche pas" + tail + " (Revolut)" + suffix;
      case 'ps_checkout':
        return "PrestaShop Checkout ne peut pas se charger" + tail + " (PrestaShop Checkout)" + suffix;
      default:
        return fallbackMessage;
    }
  }

  var STATE = {
    active: false,
    // While we are checking if the selected payment widget has mounted.
    // This prevents customers from submitting the order too early and getting
    // a confusing "payment pending" / "something went wrong" error.
    verifying: false,
    verifyingProvider: null,
    verifyingInputId: null,
    verifyingSince: 0,
    provider: null,
    reason: '',
    details: '',
    message: '',
    lastChangeAt: 0,
    // Last clicked choice (robust fallback when themes intercept selection and the radio
    // is not yet checked at the time of our evaluation).
    lastChoice: null,
    mode: null
  };

  // Diagnostic info used by "Copier le diagnostic" and (optionally) by the BO report.
  var LAST_DIAG = null;
  var LAST_DIAG_TEXT = '';
  var DIAG_REPORTED = false;

  // First time (ms epoch) a provider was detected as the active/selected one.
  // Used to add a short grace period so we don't warn while widgets are still mounting.
  var firstSeenAt = { revolut: 0, stripe: 0, paypal: 0, braintreegateway: 0, ps_checkout: 0, blank: 0 };
  var suppressedUntilProviderChange = false;

  function now() { return Date.now ? Date.now() : new Date().getTime(); }

  function log() {
    if (!DEBUG || !window.console) return;
    try { console.log.apply(console, ['[jsrequired]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  function buildDiagText(diag) {
    if (!diag) return '';
    var lines = [];
    lines.push('JSRequired diagnostic');
    if (diag.version) lines.push('Version: ' + diag.version);
    if (diag.provider) lines.push('Provider: ' + diag.provider);
    if (diag.reason) lines.push('Reason: ' + diag.reason);
    if (diag.details) lines.push('Details: ' + diag.details);
    if (diag.moduleName) lines.push('Module: ' + diag.moduleName);
    if (diag.paymentOptionId) lines.push('Payment option id: ' + diag.paymentOptionId);
    if (typeof diag.widgetReady !== 'undefined') lines.push('Widget ready: ' + (diag.widgetReady ? 'yes' : 'no'));
    if (typeof diag.globalsPresent !== 'undefined') lines.push('Globals present: ' + (diag.globalsPresent ? 'yes' : 'no'));
    if (diag.url) lines.push('Page: ' + diag.url);
    if (diag.ua) lines.push('User-Agent: ' + diag.ua);
    if (diag.ts) lines.push('Time: ' + new Date(diag.ts).toISOString());
    return lines.join('\n');
  }

  function reportBlockedOnce(diag) {
    if (!DEBUG) return;
    if (DIAG_REPORTED) return;
    if (!DIAG_URL || !DIAG_TOKEN) return;
    if (!diag || diag.status !== 'blocked') return;
    DIAG_REPORTED = true;
    try {
      fetch(DIAG_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: DIAG_TOKEN, diag: diag })
      }).catch(function(){ /* silent */ });
    } catch (e) { /* silent */ }
  }

  function copyText(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function(){ return true; }).catch(function(){ return fallbackCopy(text); });
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return Promise.resolve(!!ok);
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return (root || document).querySelectorAll(sel); }

  // Check if any visible iframe matches the selector
  function hasIframe(selector, root) {
    var iframes = qsa(selector, root || document);
    for (var i = 0; i < iframes.length; i++) {
      if (isVisible(iframes[i])) return true;
    }
    return false;
  }

  function isVisible(el) {
    if (!el) return false;
    var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    // offsetParent is null for position:fixed; also for hidden.
    if (el.offsetParent !== null) return true;
    // fallback: check bounding box
    try {
      var r = el.getBoundingClientRect();
      return !!(r && (r.width > 0 || r.height > 0));
    } catch (e) {
      return true;
    }
  }

  // ---------------------------------------------------------------------------
  // Payment-step structural heuristics
  // ---------------------------------------------------------------------------
  // In some checkouts (notably PrestaShop Checkout / ps_checkout), the payment
  // methods can become completely blank when third-party scripts are blocked.
  // In that situation there may be no visible radio/label at all, so provider-
  // specific readiness checks are not enough. We therefore add a simple,
  // provider-agnostic "blank payment list" detector.

  function getPaymentOptionsContainer(stepRoot) {
    if (!stepRoot) return null;
    return (
      stepRoot.querySelector('.payment-options') ||
      stepRoot.querySelector('.js-payment-options') ||
      stepRoot
    );
  }

  function getAllPaymentOptionInputs(stepRoot) {
    if (!stepRoot) return [];
    return qsa('input[name="payment-option"]', stepRoot);
  }

  function countVisiblePaymentOptions(stepRoot) {
    if (!stepRoot) return 0;
    var count = 0;

    // Prefer containers; themes vary but this class is common.
    var optionEls = qsa('.payment-option', stepRoot);
    optionEls.forEach(function (el) {
      if (isVisible(el)) count++;
    });

    if (count > 0) return count;

    // Fallback to inputs -> container mapping.
    var inputs = getAllPaymentOptionInputs(stepRoot);
    inputs.forEach(function (input) {
      var c = paymentOptionContainerFromInput(input);
      if (c && isVisible(c)) {
        count++;
      } else if (isVisible(input)) {
        count++;
      }
    });

    return count;
  }

  function hasAnyPaymentOptionMarkup(stepRoot) {
    if (!stepRoot) return false;
    return (
      getAllPaymentOptionInputs(stepRoot).length > 0 ||
      qsa('.payment-option', stepRoot).length > 0
    );
  }

  function paymentOptionsAreBlank(stepRoot) {
    // If there is no markup at all, we assume the step is still loading.
    if (!hasAnyPaymentOptionMarkup(stepRoot)) return false;
    return countVisiblePaymentOptions(stepRoot) === 0;
  }

  function bannerEl() { return document.getElementById('jsrequired-blocker-banner'); }

  function bannerMessageEl() { return document.getElementById('jsrequired-blocker-banner-message'); }

  function getWhatsappLinkFromBanner() {
    var b = bannerEl();
    if (!b) return null;
    // First anchor inside banner is assumed to be the WhatsApp assistance link
    var a = b.querySelector('a[href]');
    if (!a) return null;
    // avoid close button: it's a button not a link
    return { href: a.getAttribute('href'), text: (a.textContent || '').trim() || 'Assistance WhatsApp' };
  }

  function setSupportLinks(whatsappUrl) {
    var url = (typeof whatsappUrl === 'string' && whatsappUrl) || '';
    if (!url) {
      var waFromBanner = getWhatsappLinkFromBanner();
      if (waFromBanner && waFromBanner.href) {
        url = waFromBanner.href;
      }
    }

    var ids = ['jsrequired-blocker-banner-whatsapp', 'jsrequired-inline-whatsapp'];
    ids.forEach(function (id) {
      var a = document.getElementById(id);
      if (!a) return;
      if (url) {
        a.href = url;
        a.style.display = '';
      } else {
        a.style.display = 'none';
      }
    });
  }

  function ensureBannerExists() {
    // Banner is normally injected via banner.tpl; but keep a JS fallback.
    var b = bannerEl();
    if (b) return b;

    b = document.createElement('div');
    b.id = 'jsrequired-blocker-banner';
    b.setAttribute('role', 'alert');
    b.className = 'alert alert-warning';
    b.style.display = 'none';
    b.style.position = 'fixed';
    b.style.top = '0';
    b.style.left = '0';
    b.style.right = '0';
    b.style.zIndex = '999999';
    b.style.padding = '12px 16px';
    b.style.margin = '0';
    b.style.borderRadius = '0';

    var inner = document.createElement('div');
    inner.style.display = 'flex';
    inner.style.gap = '12px';
    inner.style.alignItems = 'flex-start';
    inner.style.justifyContent = 'space-between';

    var content = document.createElement('div');
    content.style.flex = '1 1 0%';
    content.style.minWidth = '0';

    var msg = document.createElement('div');
    msg.id = 'jsrequired-blocker-banner-message';
    msg.textContent = fallbackMessage;

    var actions = document.createElement('div');
    actions.style.marginTop = '8px';
    actions.style.display = 'flex';
    actions.style.flexWrap = 'wrap';
    actions.style.gap = '12px';
    actions.style.alignItems = 'center';

    var reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.className = 'jsrequired-reload';
    reloadBtn.style.padding = '4px 10px';
    reloadBtn.style.border = '1px solid rgba(0,0,0,.2)';
    reloadBtn.style.background = 'transparent';
    reloadBtn.style.cursor = 'pointer';
    reloadBtn.textContent = 'Recharger la page';

    var wa = document.createElement('a');
    wa.id = 'jsrequired-whatsapp-link';
    wa.href = WHATSAPP_URL || 'https://wa.me/0000000?text=J%27ai%20un%20probl%C3%A8me%20avec%20le%20paiement%20de%20ma%20commande';
    wa.target = '_blank';
    wa.rel = 'noopener';
    wa.textContent = 'Assistance WhatsApp';

    actions.appendChild(reloadBtn);
    actions.appendChild(wa);

    content.appendChild(msg);
    content.appendChild(actions);

    var close = document.createElement('button');
    close.type = 'button';
    close.id = 'jsrequired-blocker-close';
    close.setAttribute('aria-label', 'Fermer');
    close.style.background = 'transparent';
    close.style.border = '0';
    close.style.fontSize = '20px';
    close.style.lineHeight = '20px';
    close.style.padding = '0 6px';
    close.style.cursor = 'pointer';
    close.textContent = '×';
    close.addEventListener('click', function () {
      hideAll();
      // Do not permanently suppress; just hide until provider changes or status changes.
      suppressedUntilProviderChange = true;
    });

    inner.appendChild(content);
    inner.appendChild(close);
    b.appendChild(inner);
    document.body.insertBefore(b, document.body.firstChild);
    return b;
  }

  function ensureInlineBanner() {
    var inline = document.getElementById('jsrequired-inline-banner');
    if (inline) return inline;

    inline = document.createElement('div');
    inline.id = 'jsrequired-inline-banner';
    inline.setAttribute('role', 'alert');
    inline.className = 'alert alert-warning';
    inline.style.display = 'none';
    inline.style.padding = '12px 16px';
    inline.style.margin = '10px 0';
    inline.style.borderRadius = '4px';

    var msg = document.createElement('div');
    msg.id = 'jsrequired-inline-message';
    msg.textContent = fallbackMessage;

    inline.appendChild(msg);

    var actions = document.createElement('div');
    actions.style.marginTop = '8px';
    actions.style.display = 'flex';
    actions.style.gap = '12px';
    actions.style.flexWrap = 'wrap';
    actions.style.alignItems = 'center';

    var reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.className = 'jsrequired-reload';
    reloadBtn.textContent = 'Recharger la page';
    reloadBtn.style.padding = '4px 10px';
    reloadBtn.style.border = '1px solid rgba(0,0,0,0.3)';
    reloadBtn.style.background = 'transparent';
    reloadBtn.style.cursor = 'pointer';
    actions.appendChild(reloadBtn);

    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'jsrequired-copy-diagnostic';
    copyBtn.textContent = 'Copier le diagnostic';
    copyBtn.style.padding = '4px 10px';
    copyBtn.style.border = '1px solid rgba(0,0,0,0.3)';
    copyBtn.style.background = 'transparent';
    copyBtn.style.cursor = 'pointer';
    actions.appendChild(copyBtn);

    var wa = getWhatsappLinkFromBanner();
    var waHref = (wa && wa.href) || WHATSAPP_URL;
    if (waHref) {
      var a = document.createElement('a');
      a.href = waHref;
      a.target = '_blank';
      a.rel = 'noopener';
      a.id = 'jsrequired-whatsapp-link-inline';
      a.textContent = (wa && wa.text) || 'Assistance WhatsApp';
      actions.appendChild(a);
    }

    inline.appendChild(actions);

    // insert late; placement is handled by placeInlineBanner()
    document.body.appendChild(inline);
    return inline;
  }

  function getPaymentStepRoot() {
    return (
      qs('#checkout-payment-step') ||
      qs('#payment') ||
      qs('section#checkout-payment-step') ||
      qs('.checkout-step.-payment') ||
      qs('.checkout-step[data-step="payment"]') ||
      null
    );
  }

  // ---------------------------------------------------------------------------
  // Environment detection + last clicked payment option
  // ---------------------------------------------------------------------------

  var LAST_CHOICE_STORAGE_KEY = 'jsrequired:lastChoice';

  function detectEnvironmentMode() {
    // Requirement A: determine if ps_checkout is present.
    // - data-module-name^="ps_checkout" is the strongest marker.
    // - some themes/modules add .ps_checkout-payment-option.
    if (qs('input[name="payment-option"][data-module-name^="ps_checkout"]', document) || qs('.ps_checkout-payment-option', document)) {
      return 'ps_checkout';
    }
    return 'standalone';
  }

  function readLastChoice() {
    try {
      var raw = sessionStorage.getItem(LAST_CHOICE_STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (!parsed.id || typeof parsed.id !== 'string') return null;
      return {
        id: String(parsed.id),
        moduleName: String(parsed.moduleName || ''),
        ts: parseInt(parsed.ts || 0, 10) || 0
      };
    } catch (e) {
      return null;
    }
  }

  function persistLastChoice(choice) {
    if (!choice || !choice.id) return;
    try {
      sessionStorage.setItem(LAST_CHOICE_STORAGE_KEY, JSON.stringify(choice));
    } catch (e) {}
  }

  function setLastChoice(choice) {
    if (!choice || !choice.id) return;
    STATE.lastChoice = {
      id: String(choice.id),
      moduleName: String(choice.moduleName || ''),
      ts: parseInt(choice.ts || 0, 10) || now()
    };
    persistLastChoice(STATE.lastChoice);
  }

  function setLastChoiceFromInput(input) {
    if (!input || !input.id) return;
    setLastChoice({
      id: input.id,
      moduleName: String(input.getAttribute('data-module-name') || ''),
      ts: now()
    });
  }

  function inputFromLastChoice() {
    var c = STATE.lastChoice || readLastChoice();
    if (!c || !c.id) return null;
    var input = document.getElementById(c.id);
    if (input && input.name === 'payment-option') return input;
    return null;
  }

  function selectedPaymentInput() {
    return qs('input[name="payment-option"]:checked');
  }

  // A robust "current option" accessor (checked OR last clicked).
  function getCheckedPaymentOption() {
    return selectedPaymentInput() || inputFromLastChoice();
  }

  function paymentRadiosPresent() {
    return !!qs('input[name="payment-option"]');
  }

  function paymentOptionContainerFromInput(input) {
    if (!input) return null;
    var id = input.getAttribute('id');
    if (id) {
      var byId = document.getElementById(id + '-container');
      if (byId) return byId;
    }
    return (input.closest && input.closest('.payment-option')) || (input.closest && input.closest('.payment-option')) || null;
  }

  function getModuleNameFromInput(input) {
    if (!input) return '';
    return (input.getAttribute('data-module-name') || '').toLowerCase();
  }

  function getOptionScopes(input) {
    // Requirement D: for a given payment-option-X, check in the union:
    // - #payment-option-X-container
    // - #pay-with-payment-option-X-form
    // - #payment-option-X-additional-information
    // fallback: payment step root
    var step = getPaymentStepRoot() || document;
    if (!input || !input.id) {
      return { step: step, scopes: [step], primary: step, container: null, form: null, additional: null };
    }

    var id = input.id;
    var container = document.getElementById(id + '-container') || null;
    var form = document.getElementById('pay-with-' + id + '-form') || null;
    var additional = document.getElementById(id + '-additional-information') || null;

    var scopes = [];
    if (container) scopes.push(container);
    if (form) scopes.push(form);
    if (additional) scopes.push(additional);
    if (scopes.length === 0) scopes.push(step);

    var primary = container || form || additional || step;
    return { step: step, scopes: scopes, primary: primary, container: container, form: form, additional: additional };
  }

  function inScopes(scopesInfo, selector) {
    if (!scopesInfo || !scopesInfo.scopes) return false;
    for (var i = 0; i < scopesInfo.scopes.length; i++) {
      var scope = scopesInfo.scopes[i];
      if (scope && qs(selector, scope)) return true;
    }
    return false;
  }

  function detectProviderFromInput(input, scopesInfo) {
    var moduleName = getModuleNameFromInput(input).toLowerCase();
    var inputId = input ? (input.id || '').toLowerCase() : '';

    log('detectProviderFromInput: moduleName="' + moduleName + '", inputId="' + inputId + '"');

    // Requirement A: ps_checkout mode is determined structurally.
    if (moduleName.indexOf('ps_checkout') !== -1 || moduleName.indexOf('prestashop checkout') !== -1) {
      log('detectProviderFromInput: matched ps_checkout by moduleName');
      return 'ps_checkout';
    }

    // STEP 1: Check SPECIFIC markers for the selected payment option
    // These are tied to the actual input (moduleName, inputId, scopes)
    // Do NOT use page-wide checks here - they would incorrectly match other providers

    var revolutByModuleName = moduleName.indexOf('revolut') !== -1;
    var revolutByInputId = inputId.indexOf('revolut') !== -1;
    var revolutInScopes = inScopes(scopesInfo, '#revolut_card,[id*="revolut"]');
    log('detectProviderFromInput: revolut specific - byModuleName=' + revolutByModuleName + ', byInputId=' + revolutByInputId + ', inScopes=' + revolutInScopes);

    var stripeByModuleName = moduleName.indexOf('stripe') !== -1;
    var stripeByInputId = inputId.indexOf('stripe') !== -1;
    var stripeInScopes = inScopes(scopesInfo, '#stripe-payment-element,#payment-element,.StripeElement,[data-stripe-element]');
    log('detectProviderFromInput: stripe specific - byModuleName=' + stripeByModuleName + ', byInputId=' + stripeByInputId + ', inScopes=' + stripeInScopes);

    var paypalByModuleName = moduleName.indexOf('paypal') !== -1;
    var paypalByInputId = inputId.indexOf('paypal') !== -1;
    var paypalInScopes = inScopes(scopesInfo, '#paypal-buttons,#paypal-button-container,.paypal-buttons');
    log('detectProviderFromInput: paypal specific - byModuleName=' + paypalByModuleName + ', byInputId=' + paypalByInputId + ', inScopes=' + paypalInScopes);

    // Return based on SPECIFIC markers only (not page-wide)
    if (revolutByModuleName || revolutByInputId || revolutInScopes) {
      log('detectProviderFromInput: matched revolut by specific marker');
      return 'revolut';
    }
    if (stripeByModuleName || stripeByInputId || stripeInScopes) {
      log('detectProviderFromInput: matched stripe by specific marker');
      return 'stripe';
    }
    if (paypalByModuleName || paypalByInputId || paypalInScopes) {
      log('detectProviderFromInput: matched paypal by specific marker');
      return 'paypal';
    }

    // If we are in ps_checkout environment but the option does not expose the data-module-name,
    // fall back to structural ps_checkout markers.
    if (STATE.mode === 'ps_checkout') {
      if (inScopes(scopesInfo, '#ps_checkout-payment-container,#ps_checkout-payment,[id*="ps_checkout"],form[action*="/module/ps_checkout/"]') ||
          inScopes(scopesInfo, 'script[src*="/modules/ps_checkout/"],script[src*="ps_checkout"]') ||
          inScopes(scopesInfo, 'script[src*="paypal.com/sdk/js"][data-namespace*="ps_checkout"]')) {
        return 'ps_checkout';
      }
    }

    // Check for card payment keywords in the label/module name
    // This catches generic card payment options that need a widget
    var looksLikeCardPayment = (
      moduleName.indexOf('carte') !== -1 ||
      moduleName.indexOf('card') !== -1 ||
      moduleName.indexOf('crédit') !== -1 ||
      moduleName.indexOf('credit') !== -1 ||
      moduleName.indexOf('débit') !== -1 ||
      moduleName.indexOf('debit') !== -1
    );

    if (looksLikeCardPayment) {
      // It's a card payment - check what provider is on the page
      if (qs('script[src*="revolut"],#revolut_card,[id*="revolut"]', document)) {
        return 'revolut';
      }
      if (qs('script[src*="stripe"],.StripeElement,[id*="stripe"]', document)) {
        return 'stripe';
      }
      if (qs('script[src*="paypal"],[id*="paypal"]', document)) {
        return 'paypal';
      }
      // Generic card payment that expects a widget
      return 'generic';
    }

    // Generic detection: if the payment option has external scripts or expects iframes/widgets,
    // treat it as a generic JS-dependent payment method.
    if (paymentOptionExpectsWidget(input, scopesInfo)) {
      return 'generic';
    }

    return null;
  }

  // Check if a payment option appears to need a JS widget to function
  function paymentOptionExpectsWidget(input, scopesInfo) {
    if (!input) return false;

    var scopes = (scopesInfo && scopesInfo.scopes) ? scopesInfo.scopes : [];
    var step = getPaymentStepRoot() || document;

    // Check if there are external payment scripts in the scopes or page
    for (var i = 0; i < scopes.length; i++) {
      var scope = scopes[i];
      if (!scope) continue;

      // Look for external payment-related scripts
      var scripts = qsa('script[src]', scope);
      for (var j = 0; j < scripts.length; j++) {
        var src = (scripts[j].src || '').toLowerCase();
        // Common payment gateway domains
        if (src.indexOf('paypal') !== -1 ||
            src.indexOf('stripe') !== -1 ||
            src.indexOf('revolut') !== -1 ||
            src.indexOf('braintree') !== -1 ||
            src.indexOf('adyen') !== -1 ||
            src.indexOf('mollie') !== -1 ||
            src.indexOf('checkout.com') !== -1 ||
            src.indexOf('square') !== -1 ||
            src.indexOf('klarna') !== -1) {
          return true;
        }
      }

      // Look for placeholder divs that typically hold widgets
      if (qs('[id*="card"], [id*="payment-element"], [id*="widget"], [class*="card-field"], [class*="payment-widget"]', scope)) {
        return true;
      }
    }

    // Check the additional-information section for signs of a widget
    var id = input.id;
    var additionalInfo = id ? document.getElementById(id + '-additional-information') : null;
    if (additionalInfo) {
      // If there's an additional info section with minimal visible content but scripts/placeholders,
      // it likely expects a widget to render
      var hasScript = !!qs('script[src]', additionalInfo);
      var hasPlaceholder = !!qs('[id*="card"], [id*="payment"], [id*="widget"], [data-payment], [class*="card"], [class*="payment-form"]', additionalInfo);
      if (hasScript || hasPlaceholder) {
        return true;
      }
    }

    return false;
  }

  // Provider detection
  function detectProvider() {
    var input = getCheckedPaymentOption();
    if (!input) return null;
    var scopesInfo = getOptionScopes(input);
    return detectProviderFromInput(input, scopesInfo);
  }

  // (Removed legacy psCheckoutStandalonePresent heuristic. Environment is detected by markers in detectEnvironmentMode().)

  function relevantForProvider(provider) {
    if (!provider) return false;
    var current = detectProvider();
    // Important: do NOT treat PayPal as relevant when the detected provider is PrestaShop Checkout.
    // PS Checkout may open a popup and not render PayPal widgets in the DOM, which would create
    // false positives (banner shown even when payment works).
    return (current === provider);
  }

  function providerAge(provider) {
    if (!provider) return 0;
    if (!firstSeenAt[provider]) firstSeenAt[provider] = now();
    return now() - firstSeenAt[provider];
  }

  function resetProviderAge(provider) {
    if (!provider) return;
    firstSeenAt[provider] = 0;
  }

  // Widget heuristics
  function revolutMount(container) {
    if (!container) container = document;
    return qs('#revolut_card', container) || qs('[id^="revolut"]', container) || null;
  }

  function stripeMount(container) {
    var root = container || document;

    // Prefer known Stripe mount points (avoid matching hidden inputs like #stripe_token).
    var preferred = qsa(
      '#stripe-payment-element, #payment-element, [id*="payment-element"], [data-stripe-element], .StripeElement, #card-element, [id*="card-element"]',
      root
    );
    for (var i = 0; i < preferred.length; i++) {
      var el = preferred[i];
      if (!el || !el.tagName) continue;
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SCRIPT' || tag === 'LINK') continue;
      if (isVisible(el)) return el;
    }

    // Fallback: any visible element mentioning "stripe" in id/class, excluding form inputs.
    var candidates = qsa('[id*="stripe"], [class*="stripe"]', root);
    for (var j = 0; j < candidates.length; j++) {
      var el2 = candidates[j];
      if (!el2 || !el2.tagName) continue;
      var tag2 = (el2.tagName || '').toUpperCase();
      if (tag2 === 'INPUT' || tag2 === 'SCRIPT' || tag2 === 'LINK') continue;
      if (isVisible(el2)) return el2;
    }

    return null;
  }

  function paypalMount(container) {
    var root = container || document;

    // Typical PayPal/PS modules mount points.
    var candidates = qsa(
      // Keep this list tight: overly-broad selectors (e.g. any element with
      // "paypal" in an id/class) lead to false "ready" states when blockers
      // prevent the PayPal SDK from rendering its iframe.
      '#paypal-button-container, #paypal-buttons, .paypal-buttons, .paypal-button-container, [data-funding-source]',
      root
    );
    for (var i = 0; i < candidates.length; i++) {
      if (isVisible(candidates[i])) return candidates[i];
    }

    // PayPal smart buttons often inject zoid iframes.
    var ifr = qsa('iframe[name^="__zoid__paypal"], iframe[src*="paypal.com"], iframe[src*="paypalobjects.com"]', root);
    for (var j = 0; j < ifr.length; j++) {
      if (isVisible(ifr[j])) return ifr[j];
    }

    return null;
  }

  function hasPayPalIndicators(scope) {
    // A PayPal payment UI being *actually usable* almost always implies that
    // the SDK rendered at least one PayPal iframe (Smart Buttons / Card Fields).
    // Avoid weak signals like "a PayPal button exists" because many templates
    // ship static placeholders even when external scripts are blocked.
    var root = scope || document;
    return hasIframe('iframe[name^="__zoid__paypal"],iframe[src*="paypal.com"],iframe[src*="paypalobjects.com"],iframe[name*="paypal"]', root);
  }

  function hasNonJsPayPalFallback(scope) {
    // Some PayPal modules perform a classic redirect (no SDK, no iframes).
    // In that case this module should *not* warn about blocked scripts.
    var root = scope || document;

    // If there is an SDK script tag, treat it as a JS-based integration.
    if (qs('script[src*="paypal.com/sdk/js"]', document)) return false;

    // If PayPal iframes exist, it's JS-based.
    if (hasPayPalIndicators(root)) return false;

    // Heuristic: a visible form that posts to a PayPal module endpoint.
    var form = qs('form[action*="paypal"]', root);
    if (form) {
      var submit = qs('button[type="submit"],input[type="submit"]', form);
      if (submit && isVisible(submit)) return true;
    }

    // Or a visible link to a PayPal module route.
    var link = qs('a[href*="/module/paypal"],a[href*="module/paypal"]', root);
    if (link && isVisible(link)) return true;

    return false;
  }

  function psCheckoutBinarySection(root, moduleName) {
    if (!moduleName) return null;
    // In PS Checkout, payment content is rendered inside #payment_binaries as:
    // <section class="js-payment-binary ... js-payment-<moduleName>">
    return qs('section.js-payment-binary.js-payment-' + moduleName, root) ||
           qs('.js-payment-binary.js-payment-' + moduleName, root) ||
           null;
  }

  function psCheckoutMount(root, moduleName) {
    var scope = root || document;

    // Prefer the exact binary section for the selected PS Checkout payment method.
    var sec = psCheckoutBinarySection(scope, moduleName);
    if (sec) return sec;

    // Fallbacks: older templates or partial loads.
    return qs('#ps_checkout-card-fields-form', scope) ||
           qs('#ps_checkout-paypal-buttons-container', scope) ||
           qs('#payment_binaries', scope) ||
           null;
  }

  function hasStripeIndicators(scope) {
    var root = scope || document;

    // Stripe Elements usually inject one or more iframes and/or private element wrappers.
    var els = qsa('.__PrivateStripeElement, .StripeElement, [data-stripe], [data-stripe-element]', root);
    for (var i = 0; i < els.length; i++) {
      if (isVisible(els[i])) return true;
    }

    var iframes = qsa('iframe[src*="stripe"], iframe[name*="stripe"], iframe[title*="Stripe"], iframe[title*="Secure"]', root);
    for (var j = 0; j < iframes.length; j++) {
      if (isVisible(iframes[j])) return true;
    }

    // If Stripe.js loaded successfully, this is another strong signal.
    // Important: do NOT rely on the mere presence of a <script> tag, because
    // blockers can keep the tag in DOM while preventing the network load.
    if (typeof window !== 'undefined' && typeof window.Stripe === 'function') return true;

    return false;
  }

  function hasPsCheckoutIndicators(root, moduleName) {
    var scope = root || document;
    var mn = (moduleName || '').toLowerCase();

    // PrestaShop Checkout renders PayPal "buttons" (PayPal / PayLater / Apple Pay / Google Pay)
    // and PayPal "card hosted fields" (card).
    // IMPORTANT: avoid false positives from PayPal marketing/message iframes
    // like /credit-presentment/smart/message which are not payment widgets.
    if (mn.indexOf('ps_checkout-card') !== -1 || mn.indexOf('card') !== -1) {
      return !!qs('iframe[name^="__zoid__paypal_card_"], iframe[name^="__zoid__paypal_card__"], div[id^="zoid-paypal-card-"] iframe', scope);
    }

    return !!qs('iframe[name^="__zoid__paypal_buttons__"], div[id^="zoid-paypal-buttons-"] iframe, div[id^="zoid-paypal-applepay-"] iframe, div[id^="zoid-paypal-googlepay-"] iframe', scope);
  }

  function widgetLooksReady(provider, mount, moduleName) {
    var mn = moduleName || STATE.currentModuleName || '';
    if (!provider) return false;

    if (provider === 'revolut') {
      var scope = mount || document;
      // Requirement E: treat Revolut as ready only when its iframe/widget really appears.
      var revolutIframe = qs('iframe[src*="merchant.revolut.com"], #revolut_card iframe, iframe[data-revolut]', scope);
      log('widgetLooksReady(revolut): iframe found=' + !!revolutIframe);
      return !!revolutIframe;
    }

    if (provider === 'stripe') {
      // Stripe containers (e.g. #payment-element / .StripeElement) can exist even
      // when scripts/iframes are blocked. Require stronger signals: a Stripe iframe
      // or card inputs actually rendered.
      var scope = mount || document;
      var hasStripeIframe = !!qs('.StripeElement iframe, .__PrivateStripeElement iframe, iframe[src*="js.stripe.com"], iframe[src*="stripe.com"], iframe[name*="stripe"], iframe[title*="Stripe"]', scope);
      if (hasStripeIframe) return true;
      // Fallback for rare integrations that render real inputs (not Elements)
      // while still being Stripe-backed.
      return !!qs('input[autocomplete="cc-number"], input[name*="cardnumber"], input[id*="card-number"], input[data-stripe]', scope);
    }

    if (provider === 'paypal') {
      // For PayPal, avoid false negatives/positives by relying on the
      // strongest on-page signal: the SDK-rendered iframes.
      return hasPayPalIndicators(mount || document);
    }

    if (provider === 'ps_checkout') {
      // PrestaShop Checkout has two UX patterns:
      // 1) Embedded widgets (zoid iframes) for buttons/hosted fields.
      // 2) Popup flows where *no* iframe is present in the page until the user clicks.
      //
      // Therefore we must not treat "no iframe" as "blocked" when the payment
      // options are visible (the user can still proceed via popup).
      var step = getPaymentStepRoot();
      if (step && countVisiblePaymentOptions(step) > 0) {
        return true;
      }

      // If the payment step is present but completely blank, we consider it NOT ready.
      // The banner logic will handle this case.

      // Otherwise, fall back to checking embedded widget indicators.
      // These selectors exclude PayPal marketing/message iframes, so a global fallback is safe.
      return hasPsCheckoutIndicators(mount || document, mn) ||
             hasPsCheckoutIndicators(document, mn);
    }

    if (provider === 'generic') {
      // For generic payment widgets, check if there are visible iframes or
      // interactive elements that indicate the widget has loaded
      var scope = mount || document;

      // Check for any payment-related iframes
      if (hasIframe('iframe[src*="paypal"],iframe[src*="stripe"],iframe[src*="revolut"],iframe[src*="braintree"],iframe[src*="adyen"],iframe[src*="mollie"],iframe[src*="checkout.com"],iframe[src*="klarna"]', scope)) {
        return true;
      }

      // Check for visible card input fields (real inputs, not placeholders)
      var cardInputs = qsa('input[autocomplete="cc-number"], input[name*="card"], input[id*="card-number"], input[placeholder*="card"], input[type="tel"][maxlength="19"]', scope);
      for (var gi = 0; gi < cardInputs.length; gi++) {
        if (isVisible(cardInputs[gi])) return true;
      }

      // Check for any visible iframe in the payment additional info
      var input = getCheckedPaymentOption();
      if (input && input.id) {
        var additionalInfo = document.getElementById(input.id + '-additional-information');
        if (additionalInfo) {
          var iframes = qsa('iframe', additionalInfo);
          for (var gj = 0; gj < iframes.length; gj++) {
            if (isVisible(iframes[gj])) return true;
          }
        }
      }

      return false;
    }

    return false;
  }

  function providerGlobalsPresent(provider) {
    if (!provider) return false;

    if (provider === 'revolut') return typeof window.RevolutCheckout !== 'undefined';
    if (provider === 'stripe') return typeof window.Stripe !== 'undefined' || typeof window.stripe !== 'undefined';
    if (provider === 'paypal') {
      // A PayPal SDK <script> tag can exist even when the request is blocked
      // (ERR_BLOCKED_BY_CLIENT/CSP). Only consider the SDK present when the
      // global object is actually available.
      return typeof window.paypal !== 'undefined';
    }

    if (provider === 'ps_checkout') {
      // PS Checkout can be loaded via bundles, deferred scripts, or consent managers.
      // Don't tie this to widget DOM.
      return !!qs('input[name="payment-option"][data-module-name^="ps_checkout"]', document) ||
             !!qs('#payment_binaries .js-payment-binary.ps_checkout', document);
    }

    return false;
  }

  function placeInlineBanner(container) {
    var inline = ensureInlineBanner();
    if (!inline) return;

    var input = selectedPaymentInput();
    var anchor = null;
    var insertAfterEl = null;

    if (input) {
      // Try to find the additional-information or form section for this payment option
      var id = input.id;
      var additionalInfo = id ? document.getElementById(id + '-additional-information') : null;
      var formSection = id ? document.getElementById('pay-with-' + id + '-form') : null;

      // Prefer placing after the additional-information or form section
      // This avoids interfering with the clickable payment option header
      if (additionalInfo && isVisible(additionalInfo)) {
        anchor = additionalInfo.parentNode || container || getPaymentStepRoot();
        insertAfterEl = additionalInfo;
      } else if (formSection && isVisible(formSection)) {
        anchor = formSection.parentNode || container || getPaymentStepRoot();
        insertAfterEl = formSection;
      } else {
        anchor = paymentOptionContainerFromInput(input) || container || getPaymentStepRoot();
      }
    } else {
      anchor = getPaymentStepRoot() || container;
    }

    if (!anchor) return;

    // Ensure the inline banner is inside the anchor
    try {
      if (inline.parentNode !== anchor || (insertAfterEl && inline.previousElementSibling !== insertAfterEl)) {
        // Remove from current parent
        if (inline.parentNode) inline.parentNode.removeChild(inline);

        // Place after the payment content (not at the beginning) to avoid click interference
        if (insertAfterEl && insertAfterEl.nextSibling) {
          anchor.insertBefore(inline, insertAfterEl.nextSibling);
        } else if (insertAfterEl) {
          anchor.appendChild(inline);
        } else {
          // Fallback: append at end of anchor instead of beginning
          anchor.appendChild(inline);
        }
      }
    } catch (e) {
      // fallback to body
      if (inline.parentNode !== document.body) document.body.appendChild(inline);
    }
  }

  function setDataAttrs(el, provider, reason, details) {
    if (!el) return;
    el.setAttribute('data-jsrequired-version', VERSION);
    el.setAttribute('data-jsrequired-provider', provider || '');
    el.setAttribute('data-jsrequired-reason', reason || '');
    if (details) el.setAttribute('data-jsrequired-details', details);
    else el.removeAttribute('data-jsrequired-details');
  }

  function setVerifying(on, provider, inputId) {
    if (on) {
      STATE.verifying = true;
      STATE.verifyingProvider = provider || null;
      STATE.verifyingInputId = inputId || null;
      STATE.verifyingSince = now();
    } else {
      STATE.verifying = false;
      STATE.verifyingProvider = null;
      STATE.verifyingInputId = null;
      STATE.verifyingSince = 0;
    }
  }

  function verifyingMessage(provider) {
    var p = normalizeProviderForMessage(provider);
    switch (p) {
      case 'paypal':
        return 'Préparation du paiement PayPal en cours…';
      case 'stripe':
        return 'Préparation du champ carte Stripe en cours…';
      case 'revolut':
        return 'Préparation du champ carte Revolut en cours…';
      case 'ps_checkout':
        return 'Préparation de PrestaShop Checkout en cours…';
      case 'generic':
        return 'Préparation du moyen de paiement en cours…';
      default:
        return 'Préparation du paiement en cours…';
    }
  }

  // Timer for delayed verifying message display
  var verifyingDisplayTimer = null;
  var VERIFYING_DISPLAY_DELAY = 700; // ms before showing "verifying" message

  function showVerifying(provider, container) {
    // Keep banner hidden during the verification phase; we only show a clear
    // warning when we are sure the widget did not mount.
    var b = bannerEl();
    if (b) b.style.display = 'none';

    // Always disable the confirm button immediately for safety
    disableConfirm(true);

    if (!SHOW_INLINE) {
      return;
    }

    // Clear any pending display timer
    if (verifyingDisplayTimer) {
      window.clearTimeout(verifyingDisplayTimer);
      verifyingDisplayTimer = null;
    }

    // Delay showing the inline message to avoid flickering/interference
    // when widgets load quickly
    verifyingDisplayTimer = window.setTimeout(function() {
      verifyingDisplayTimer = null;

      // Check if we're still in verifying state
      if (!STATE.verifying) return;
      // Check if widget became ready in the meantime
      if (STATE.active) return;

      var inline = ensureInlineBanner();
      inline.className = 'alert alert-info';
      var inlineMsg = document.getElementById('jsrequired-inline-message');
      if (inlineMsg) inlineMsg.textContent = verifyingMessage(provider) + ' Si cela reste bloqué, un message explicatif s\'affichera.';

      // During verification, the "Copier le diagnostic" button would copy the previous
      // blocked snapshot (or nothing). Hide it to avoid confusion.
      var copyBtn = inline.querySelector('.jsrequired-copy-diagnostic');
      if (copyBtn) copyBtn.style.display = 'none';

      placeInlineBanner(container || getPaymentStepRoot() || document.body);
      inline.style.display = 'block';
    }, VERIFYING_DISPLAY_DELAY);
  }

  function hideVerifying() {
    // Clear any pending display timer
    if (verifyingDisplayTimer) {
      window.clearTimeout(verifyingDisplayTimer);
      verifyingDisplayTimer = null;
    }

    if (!STATE.verifying) return;

    setVerifying(false);

    var inline = document.getElementById('jsrequired-inline-banner');
    if (inline && !STATE.active) {
      // Restore default styling only if we are not showing the blocked warning.
      inline.className = 'alert alert-warning';
      var copyBtn = inline.querySelector('.jsrequired-copy-diagnostic');
      if (copyBtn) copyBtn.style.display = '';
      inline.style.display = 'none';
    }

    // Re-enable confirmation if we were the ones who disabled it.
    if (!STATE.active) disableConfirm(false);
  }

  function showAll(provider, reason, details, container, diagExtras) {
    // If we were in a "verification" phase, we now have a definitive outcome.
    // Make sure any temporary UI state is reset.
    if (STATE.verifying) {
      setVerifying(false);
      var inline0 = document.getElementById('jsrequired-inline-banner');
      if (inline0) {
        inline0.className = 'alert alert-warning';
        var copy0 = inline0.querySelector('.jsrequired-copy-diagnostic');
        if (copy0) copy0.style.display = '';
      }
    }
    if (suppressedUntilProviderChange && provider === STATE.provider) {
      // User closed the banner and provider didn't change; keep suppressed until status changes to "ok" then blocked again.
      return;
    }

    var normalizedProvider = normalizeProviderForMessage(provider);
    var msgText = buildContextMessage(normalizedProvider);

    STATE.active = true;
    STATE.provider = provider || null;
    STATE.reason = reason || '';
    STATE.details = details || '';
    STATE.message = msgText || fallbackMessage;
    STATE.lastChangeAt = now();

    // Build a diagnostic snapshot (used for copy + optional BO reporting).
    var selected = getCheckedPaymentOption();
    var extras = (diagExtras && typeof diagExtras === 'object') ? diagExtras : {};
    LAST_DIAG = {
      status: 'blocked',
      provider: (provider || ''),
      providerNorm: normalizedProvider,
      reason: (reason || ''),
      details: (details || ''),
      paymentOptionId: selected ? selected.id : '',
      moduleName: selected ? (selected.getAttribute('data-module-name') || '') : '',
      expected: String(extras.expected || ''),
      found: String(extras.found || ''),
      widgetReady: (typeof extras.widgetReady !== 'undefined') ? !!extras.widgetReady : undefined,
      globalsPresent: (typeof extras.globalsPresent !== 'undefined') ? !!extras.globalsPresent : undefined,
      url: (window.location && window.location.href) ? window.location.href : '',
      ua: (window.navigator && window.navigator.userAgent) ? window.navigator.userAgent : '',
      ts: new Date().toISOString(),
      version: (typeof window.jsrequiredVersion !== 'undefined') ? String(window.jsrequiredVersion) : VERSION
    };
    LAST_DIAG_TEXT = buildDiagText(LAST_DIAG);
    // Persist a ready-to-copy summary for the BO panel.
    LAST_DIAG.summary = LAST_DIAG_TEXT;
    reportBlockedOnce(LAST_DIAG);

    // Banner (sticky)
    var b = bannerEl();
    if (SHOW_BANNER) {
      b = ensureBannerExists();
      setDataAttrs(b, provider, reason, details);
      var msgEl = bannerMessageEl();
      if (msgEl) msgEl.textContent = STATE.message;

      // Support links (if configured)
      if (WHATSAPP_URL) {
        var wa = document.getElementById('jsrequired-blocker-banner-whatsapp');
        if (wa) wa.href = WHATSAPP_URL;
      }

      b.style.display = 'block';
    } else {
      if (b) b.style.display = 'none';
    }

    // Inline message (payment block)
    var inline = document.getElementById('jsrequired-inline-banner');
    if (SHOW_INLINE) {
      inline = ensureInlineBanner();
      setDataAttrs(inline, provider, reason, details);
      var inlineMsg = document.getElementById('jsrequired-inline-message');
      if (inlineMsg) inlineMsg.textContent = STATE.message;

      if (WHATSAPP_URL) {
        var waInline = document.getElementById('jsrequired-inline-whatsapp');
        if (waInline) {
          waInline.href = WHATSAPP_URL;
          waInline.style.display = '';
        }
      }

      placeInlineBanner(container);
      inline.style.display = 'block';
    } else {
      if (inline) inline.style.display = 'none';
    }

    disableConfirm(true);

    log('SHOW', provider, reason, details || '');
  }

  function hideAll() {
    // Clear any verification UI/state first.
    if (STATE.verifying) {
      hideVerifying();
    }
    STATE.active = false;
    STATE.reason = '';
    STATE.details = '';
    STATE.message = '';
    STATE.lastChangeAt = now();

    var b = bannerEl();
    if (b) b.style.display = 'none';

    var inline = document.getElementById('jsrequired-inline-banner');
    if (inline) inline.style.display = 'none';

    disableConfirm(false);

    // Allow a new report if the issue reappears later.
    DIAG_REPORTED = false;

    log('HIDE');
  }

  // Confirmation button disabling
  function findConfirmTargets() {
    var list = [];
    var paymentConfirmation = qs('#payment-confirmation');
    if (paymentConfirmation) {
      var btns = qsa('button, input[type="submit"], a', paymentConfirmation);
      for (var i = 0; i < btns.length; i++) list.push(btns[i]);
    }

    // Additional common selectors
    var extra = qsa(
      'button[name="confirmOrder"], button.js-confirm-order, button[data-link-action="confirm-order"], ' +
      '#order-confirmation button[type="submit"], ' +
      // Common third-party checkout buttons (e.g. TheCheckout)
      '#confirm_order, button#confirm_order, button[name="confirm_order"], button[id*="confirm_order"]'
    );
    for (var j = 0; j < extra.length; j++) list.push(extra[j]);

    // De-duplicate
    var unique = [];
    var seen = [];
    for (var k = 0; k < list.length; k++) {
      var el = list[k];
      if (!el || seen.indexOf(el) !== -1) continue;
      seen.push(el);
      unique.push(el);
    }
    return unique;
  }

  function disableConfirm(disable) {
    var targets = findConfirmTargets();
    for (var i = 0; i < targets.length; i++) {
      var el = targets[i];
      if (!el) continue;

      // Only disable actionable elements
      if (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'submit')) {
        if (disable) {
          el.disabled = true;
          el.setAttribute('aria-disabled', 'true');
          el.setAttribute('data-jsrequired-disabled', '1');
          el.title = el.title || STATE.message || fallbackMessage;
        } else if (el.getAttribute('data-jsrequired-disabled') === '1') {
          el.disabled = false;
          el.setAttribute('aria-disabled', 'false');
          el.removeAttribute('data-jsrequired-disabled');
        }
      } else if (el.tagName === 'A') {
        if (disable) {
          el.setAttribute('data-jsrequired-disabled', '1');
          el.setAttribute('aria-disabled', 'true');
          el.style.pointerEvents = 'none';
          el.style.opacity = '0.6';
          el.title = el.title || STATE.message || fallbackMessage;
        } else if (el.getAttribute('data-jsrequired-disabled') === '1') {
          el.removeAttribute('data-jsrequired-disabled');
          el.setAttribute('aria-disabled', 'false');
          el.style.pointerEvents = '';
          el.style.opacity = '';
        }
      }
    }
  }

  // Prevent form submission as a second line of defense
  function attachSubmitGuard() {
    document.addEventListener('submit', function (e) {
      if (!STATE.active && !STATE.verifying) return;
      // If blocked OR still verifying, block submit and ensure the customer sees why.
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch (err) {}
      var step = getPaymentStepRoot();
      placeInlineBanner(step);
      if (STATE.active) {
        showAll(STATE.provider, STATE.reason || 'blocked', STATE.details || '', step);
      } else {
        // Still checking: show an informational inline message and keep "Commander" disabled.
        showVerifying(STATE.verifyingProvider || detectProvider() || null, step);
      }
      scrollToInline();
      return false;
    }, true);
  }

  function scrollToInline() {
    var inline = document.getElementById('jsrequired-inline-banner');
    if (!inline || !isVisible(inline)) return;
    try {
      inline.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      // fallback
      var r = inline.getBoundingClientRect();
      window.scrollTo(0, (window.pageYOffset || document.documentElement.scrollTop || 0) + r.top - 20);
    }
  }

  // ---------------------------------------------------------------------------
  // Click-driven async check (standalone + ps_checkout options)
  // ---------------------------------------------------------------------------

  var PENDING = null;
  var PENDING_TIMER = null;

  function stopPendingCheck() {
    if (PENDING_TIMER) {
      try { window.clearTimeout(PENDING_TIMER); } catch (e) {}
    }
    PENDING_TIMER = null;
    PENDING = null;
  }

  function widgetReadyInScopes(provider, scopesInfo, input) {
    if (!provider) return false;
    var step = (scopesInfo && scopesInfo.step) ? scopesInfo.step : (getPaymentStepRoot() || document);
    var scopes = (scopesInfo && scopesInfo.scopes) ? scopesInfo.scopes : [step];

    if (provider === 'ps_checkout') {
      // PS Checkout can use popup flows. Treat as ready when payment options are visible.
      if (step && countVisiblePaymentOptions(step) > 0) return true;
      // Otherwise, rely on embedded widget indicators.
      for (var i = 0; i < scopes.length; i++) {
        if (hasPsCheckoutIndicators(scopes[i] || document, getModuleNameFromInput(input))) return true;
      }
      return hasPsCheckoutIndicators(document, getModuleNameFromInput(input));
    }

    if (provider === 'revolut') {
      for (var j = 0; j < scopes.length; j++) {
        if (widgetLooksReady('revolut', scopes[j])) return true;
      }
      return widgetLooksReady('revolut', document);
    }

    if (provider === 'stripe') {
      for (var k = 0; k < scopes.length; k++) {
        if (hasStripeIndicators(scopes[k] || document)) return true;
      }
      return hasStripeIndicators(document);
    }

    if (provider === 'paypal') {
      // Non-JS redirect flow: do not warn.
      for (var l = 0; l < scopes.length; l++) {
        if (hasNonJsPayPalFallback(scopes[l] || document)) return true;
      }
      // Strong signal: SDK-rendered iframes.
      for (var m = 0; m < scopes.length; m++) {
        if (hasPayPalIndicators(scopes[m] || document)) return true;
      }
      return hasPayPalIndicators(document);
    }

    // Default: use widgetLooksReady on each scope.
    for (var n = 0; n < scopes.length; n++) {
      if (widgetLooksReady(provider, scopes[n] || document)) return true;
    }
    return widgetLooksReady(provider, document);
  }

  function startAsyncCheckForInput(input, sourceLabel) {
    if (!input || !input.id) return;

    // Only run the async mounting check for providers we explicitly support.
    // Otherwise we could mistakenly disable "Commander" for unrelated payment modules.
    var scopesInfo0 = getOptionScopes(input);
    var providerHint = detectProviderFromInput(input, scopesInfo0);

    // If the customer switches away from a previously blocked option, hide the warning.
    var previousBlockedOptionId = (LAST_DIAG && LAST_DIAG.paymentOptionId) ? String(LAST_DIAG.paymentOptionId) : '';
    stopPendingCheck();
    if (STATE.active && input.id && previousBlockedOptionId && previousBlockedOptionId !== input.id) {
      hideAll();
    }

    // Reset any previous verification UI when switching payment options.
    if (STATE.verifying && STATE.verifyingInputId && STATE.verifyingInputId !== input.id) {
      hideVerifying();
    }

    if (!providerHint) {
      // Not a supported provider: do not interfere with checkout.
      return;
    }

    // Immediately prevent early submission while we verify the widget has mounted.
    setVerifying(true, providerHint, input.id);
    showVerifying(providerHint, scopesInfo0.primary);

    // Short grace period to let widgets mount. In practice, a long delay feels
    // like the module is "not reacting". We therefore bias towards faster
    // first checks while keeping the overall timeout within the 4–6s window.
    var firstDelay = 220 + Math.floor(Math.random() * 181); // 220–400ms
    var retryMs = 250;
    var timeoutMs = 4500; // 4–6 seconds

    var startTs = now();
    var moduleName = String(input.getAttribute('data-module-name') || '');
    PENDING = {
      inputId: input.id,
      moduleName: moduleName,
      startTs: startTs,
      firstDelay: firstDelay,
      retryMs: retryMs,
      timeoutMs: timeoutMs,
      source: String(sourceLabel || 'click'),
      providerHint: providerHint
    };

    function tick() {
      if (!PENDING || PENDING.inputId !== input.id) return;

      var currentInput = document.getElementById(PENDING.inputId);
      if (!currentInput || currentInput.name !== 'payment-option') {
        stopPendingCheck();
        return;
      }

      var scopesInfo = getOptionScopes(currentInput);
      var provider = detectProviderFromInput(currentInput, scopesInfo) || PENDING.providerHint || null;
      if (!provider) {
        // If we lost provider detection (rare), avoid blocking checkout forever.
        stopPendingCheck();
        hideAll();
        return;
      }

      // Provider change resets suppression and updates the verification message.
      if (provider && provider !== STATE.provider) suppressedUntilProviderChange = false;
      if (STATE.verifying && provider !== STATE.verifyingProvider) {
        STATE.verifyingProvider = provider;
        showVerifying(provider, scopesInfo.primary);
      }

      var ready = widgetReadyInScopes(provider, scopesInfo, currentInput);
      if (ready) {
        stopPendingCheck();
        hideAll();
        return;
      }

      var elapsed = now() - PENDING.startTs;
      if (elapsed >= PENDING.timeoutMs) {
        var globalsOk = providerGlobalsPresent(provider);
        showAll(
          provider,
          provider + '_timeout',
          'widget_missing',
          scopesInfo.primary,
          {
            expected: provider,
            found: 'missing_after_timeout',
            widgetReady: false,
            globalsPresent: globalsOk
          }
        );
        stopPendingCheck();
        return;
      }

      PENDING_TIMER = window.setTimeout(tick, PENDING.retryMs);
    }

    PENDING_TIMER = window.setTimeout(tick, firstDelay);
    log('async check scheduled', input.id, moduleName, 'delay', firstDelay, 'source', PENDING.source);
  }

  // Main evaluation
  function evaluate() {
    var stepRoot = getPaymentStepRoot();
    if (!stepRoot || !isVisible(stepRoot)) {
      stopPendingCheck();
      hideAll();
      return;
    }

    if (!STATE.mode) STATE.mode = detectEnvironmentMode();

    // Requirement E (ps_checkout): when the payment step is visible but no payment option is
    // visible/clickable, the customer is blocked with a blank payment area.
    if (STATE.mode === 'ps_checkout' && paymentOptionsAreBlank(stepRoot)) {
      showAll(
        'ps_checkout',
        'ps_checkout_blank',
        'payment_options_blank',
        stepRoot,
        { expected: 'payment options', found: 'none_visible', widgetReady: false }
      );
      return;
    }

    // If a banner is active or we have a pending check, we continuously re-check readiness
    // to auto-hide as soon as the widget appears.
    var input = getCheckedPaymentOption();
    if (!input) return;

    var scopesInfo = getOptionScopes(input);
    var provider = detectProviderFromInput(input, scopesInfo);
    if (!provider) return;

    if (PENDING && PENDING.inputId === input.id) {
      if (widgetReadyInScopes(provider, scopesInfo, input)) {
        stopPendingCheck();
        hideAll();
      }
      return;
    }

    if (STATE.active) {
      if (widgetReadyInScopes(provider, scopesInfo, input)) {
        hideAll();
      } else {
        disableConfirm(true);
      }
    }
  }

  // Watch payment option selection changes and DOM updates
  function attachEvents() {
    function findPaymentInputFromTarget(el) {
      if (!el) return null;

      try {
        if (el.matches && el.matches('input[name="payment-option"]')) return el;
      } catch (e) {}

      // Theme interceptors frequently bind on label clicks.
      var label = (el.closest && el.closest('label[for]')) || null;
      if (label) {
        var forId = label.getAttribute('for');
        if (forId) {
          var byId = document.getElementById(forId);
          if (byId && byId.name === 'payment-option') return byId;
        }
      }

      // Generic option container.
      var opt = (el.closest && el.closest('.payment-option')) || null;
      if (opt) {
        var inOpt = qs('input[name="payment-option"]', opt);
        if (inOpt) return inOpt;
      }

      // Some themes bind on the -container div.
      var container = (el.closest && el.closest('[id$="-container"]')) || null;
      if (container && container.id) {
        var candidateId = container.id.replace(/-container$/, '');
        var inBy = document.getElementById(candidateId);
        if (inBy && inBy.name === 'payment-option') return inBy;
      }

      return null;
    }

    function onChoice(input, src) {
      if (!input) return;
      setLastChoiceFromInput(input);
      suppressedUntilProviderChange = false;
      // Requirement C: start the async check immediately on interaction.
      startAsyncCheckForInput(input, src);
      evaluateSoon();
    }

    var lastPointerDownTs = 0;

    // Requirement B: capture early user intent (before "checked" becomes true).
    document.addEventListener('pointerdown', function (e) {
      var input = findPaymentInputFromTarget(e.target);
      if (!input) return;
      lastPointerDownTs = now();
      onChoice(input, 'pointerdown');
    }, true);

    // Close + reload + copy buttons (works for both Smarty template and JS-inserted banners)
    // + click fallback for themes that do not emit pointerdown.
    document.addEventListener('click', function (e) {
      var target = e.target;
      if (!target || !target.closest) return;

      var closeBtn = target.closest('#jsrequired-blocker-close');
      if (closeBtn) {
        e.preventDefault();
        suppressedUntilProviderChange = true;
        hideAll();
        return;
      }

      var reloadBtn = target.closest('.jsrequired-reload');
      if (reloadBtn) {
        e.preventDefault();
        try { window.location.reload(); } catch (err) {}
        return;
      }

      var copyBtn = target.closest('.jsrequired-copy-diagnostic');
      if (copyBtn) {
        e.preventDefault();
        var text = LAST_DIAG_TEXT || buildDiagText(LAST_DIAG);
        copyText(text).then(function (ok) {
          if (!ok) return;
          try {
            var prev = copyBtn.textContent;
            copyBtn.textContent = 'Copié';
            setTimeout(function () { copyBtn.textContent = prev; }, 1200);
          } catch (err) {}
        });
        return;
      }

      // If pointerdown already handled the choice, ignore the subsequent click.
      if (lastPointerDownTs && (now() - lastPointerDownTs) < 260) return;

      var input = findPaymentInputFromTarget(target);
      if (input) onChoice(input, 'click');
    }, true);

    // Change events are still useful for themes that toggle checked late.
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.name === 'payment-option') {
        setLastChoiceFromInput(t);
        startAsyncCheckForInput(t, 'change');
        evaluateSoon();
      }
    }, true);

    // Observe DOM mutations (widgets render dynamically)
    try {
      var mo = new MutationObserver(function () {
        evaluateSoon();
      });
      mo.observe(document.documentElement || document.body, { childList: true, subtree: true, attributes: false });
    } catch (e) {}

    // Re-check periodically for a short time after load and after selection
    startSelectionWatch();
  }

  var evalTimer = null;
  function evaluateSoon() {
    if (evalTimer) window.clearTimeout(evalTimer);
    evalTimer = window.setTimeout(function () {
      evalTimer = null;
      evaluate();
    }, 250);
  }

  function startSelectionWatch() {
    var started = now();
    var maxMs = 12000;
    var tickMs = 800;
    var t = window.setInterval(function () {
      evaluate();
      if (now() - started > maxMs) window.clearInterval(t);
    }, tickMs);
  }

  // Detect blocked external resources (ERR_BLOCKED_BY_CLIENT typically triggers script/image error event)
  function providerFromUrl(url) {
    url = (url || '').toLowerCase();
    if (url.indexOf('revolut') !== -1) return 'revolut';
    if (url.indexOf('stripe.com') !== -1 || url.indexOf('js.stripe.com') !== -1) return 'stripe';
    if (url.indexOf('paypal.com') !== -1 || url.indexOf('paypalobjects.com') !== -1) return 'paypal';
    if (url.indexOf('braintreegateway.com') !== -1) return 'ps_checkout';
    return null;
  }

  function attachResourceBlockTrap() {
    window.addEventListener('error', function (e) {
      var t = e && e.target;
      if (!t) return;
      var tag = (t.tagName || '').toLowerCase();
      if (tag !== 'script' && tag !== 'iframe' && tag !== 'img' && tag !== 'link') return;
      var url = t.src || t.href;
      if (!url) return;

      var p = providerFromUrl(url);
      if (!p) return;

      // Only warn when the provider is currently relevant (selected or standalone)
      if (!relevantForProvider(p)) return;

      log('resource blocked', p, url);
      // force seen age so we can show without waiting too long
      firstSeenAt[p] = firstSeenAt[p] || (now() - 99999);
      showAll(p, p + '_resource_blocked', url, getPaymentStepRoot());
    }, true);

    // fetch trap
    if (window.fetch) {
      var _fetch = window.fetch;
      window.fetch = function () {
        var req = arguments[0];
        var url = '';
        try {
          url = (typeof req === 'string') ? req : (req && req.url) || '';
        } catch (e) {}
        var p = providerFromUrl(url);
        return _fetch.apply(this, arguments).catch(function (err) {
          if (p && relevantForProvider(p)) {
            log('fetch blocked', p, url, err && err.message ? err.message : '');
            firstSeenAt[p] = firstSeenAt[p] || (now() - 99999);
            showAll(p, p + '_fetch_blocked', url, getPaymentStepRoot());
          }
          throw err;
        });
      };
    }

    // XHR trap
    try {
      var _open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__jsrequired_url = url;
        return _open.apply(this, arguments);
      };
      var _send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        var url = xhr.__jsrequired_url || '';
        var p = providerFromUrl(url);
        if (p) {
          xhr.addEventListener('error', function () {
            if (relevantForProvider(p)) {
              log('xhr blocked', p, url);
              firstSeenAt[p] = firstSeenAt[p] || (now() - 99999);
              showAll(p, p + '_xhr_blocked', url, getPaymentStepRoot());
            }
          });
        }
        return _send.apply(this, arguments);
      };
    } catch (e) {}
  }

  // Detect runtime reference errors ("Stripe is not defined", etc.)
  function attachRuntimeErrorTrap() {
    window.addEventListener('error', function (e) {
      if (!e || !e.message) return;
      var msg = String(e.message || '').toLowerCase();
      var p = null;

      if (msg.indexOf('revolutcheckout') !== -1 && msg.indexOf('not defined') !== -1) p = 'revolut';
      else if (msg.indexOf('stripe') !== -1 && msg.indexOf('not defined') !== -1) p = 'stripe';
      else if (msg.indexOf('paypal') !== -1 && msg.indexOf('not defined') !== -1) p = 'paypal';

      if (!p) return;
      if (!relevantForProvider(p)) return;

      log('runtime error', p, e.message);
      firstSeenAt[p] = firstSeenAt[p] || (now() - 99999);
      showAll(p, p + '_runtime_error', e.message, getPaymentStepRoot());
    });
  }

  function init() {
    log('init: starting jsrequired v' + VERSION);

    // Detect env mode once early (can be recomputed later if needed).
    STATE.mode = detectEnvironmentMode();
    log('init: mode=' + STATE.mode);

    // Restore last clicked payment option to keep behavior robust when themes
    // intercept selection and the radio isn't checked yet.
    STATE.lastChoice = readLastChoice();

    ensureBannerExists();
    ensureInlineBanner();

    // keep inline hidden by default
    hideAll();

    attachSubmitGuard();
    attachResourceBlockTrap();
    attachRuntimeErrorTrap();
    attachEvents();

    // IMPORTANT: If a payment option is already selected on page load,
    // start the async check immediately (don't wait for user interaction).
    var preSelectedInput = selectedPaymentInput();
    if (preSelectedInput) {
      log('init: found pre-selected payment option:', preSelectedInput.id);
      setLastChoiceFromInput(preSelectedInput);
      // Use a small delay to let the page finish rendering
      window.setTimeout(function() {
        var stillSelected = selectedPaymentInput();
        if (stillSelected && stillSelected.id === preSelectedInput.id) {
          log('init: starting async check for pre-selected option:', stillSelected.id);
          startAsyncCheckForInput(stillSelected, 'init');
        }
      }, 500);
    } else {
      log('init: no pre-selected payment option');
    }

    evaluateSoon();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
