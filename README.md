# jsrequired — Detect blocked payment scripts/iframes (PrestaShop 1.7)

**jsrequired** is a PrestaShop 1.7 module that detects when a payment method cannot load because required scripts/iframes are blocked by the customer’s browser (NoScript, uBlock/AdBlock, anti-tracker) or by a security policy (CSP).  
It shows a clear, provider-specific message **at the right time** (as soon as the customer clicks a payment option) and prevents confusing checkout failures such as *“Something went wrong… Payment Status: PENDING”*.

The module is designed to work:
- in **standalone** mode (PayPal / Stripe / Revolut modules, etc.)
- and with **PrestaShop Checkout** (`ps_checkout`)

---

## Why this exists

When payment resources are blocked:
- the provider widget (Stripe/PayPal/Revolut/Checkout) never renders,
- the customer can still click **Place order**,
- and the shop ends up with a generic error and/or a **PENDING** payment state.

**jsrequired** solves this by:
1) detecting that the expected widget did not appear,
2) showing an explicit, contextual message,
3) disabling **Place order** until payment is ready (or confirmed blocked).

---

## Features

### Detection & UX
- Message displayed **immediately on click** (even if the radio input is not yet `checked`).
- Immediate “verification lock”: **disables “Place order”** to prevent premature submissions.
- Two modes:
  - **Standalone**: PayPal / Stripe (official PrestaShop module) / Revolut (and others via fallback)
  - **ps_checkout**: dedicated compatibility + handles the **“blank checkout”** case (section visible but no option is clickable)
- **Sticky banner** + **inline** message (configurable in Back Office).
- **Reload page** button.
- Provider-specific messaging:
  - PayPal: “PayPal cannot load…”
  - Stripe: “Stripe card field does not appear…”
  - Revolut: “Revolut card field does not appear…”
  - PrestaShop Checkout: “PrestaShop Checkout cannot load…”
- Robust fallback: tracks the **last clicked payment option** (works with themes/modules that select options in non-standard ways).

### Debug & diagnostics (optional)
- **Back Office Debug mode**:
  - console logs prefixed with `[jsrequired]` only when debug is enabled,
  - diagnostic POST to a FrontController **only when blocked is confirmed**.
- “**Last detection**” stored in BO **only** when a block is confirmed.
- **Copy diagnostic** button:
  - Front: copies a short summary (provider, reason, option id, module, URL, UA, version),
  - BO: copies the last stored diagnostic.

---

## Compatibility

- PrestaShop **1.7.x**
- Themes: compatible with Classic and most themes using the standard payment-option markup.
- Tested providers / modules:
  - **Revolut**
  - **Stripe** (official PrestaShop module)
  - **PayPal**
  - **ps_checkout** (PrestaShop Checkout)

> Note: detection relies on DOM heuristics + common network/console error patterns. Highly customized themes may require adding selectors.

---

## Installation

1. Download the module archive (`jsrequired.zip`) from releases or your build output.
2. PrestaShop Back Office → **Modules** → **Module Manager** → **Upload a module**.
3. Install and configure.

---

## Configuration (Back Office)

Main settings:
- **Display**: sticky banner / inline message (or both depending on version).
- **Disable “Place order”**: enabled by default for widget-based providers.
- **Debug mode**:
  - OFF: no console logs, no diagnostic POST
  - ON: `[jsrequired]` logs + diagnostic sent only if a block is confirmed

---

## How it works (high-level)

### A) Environment detection
- If payment options contain `data-module-name^="ps_checkout"` or `.ps_checkout-payment-option` → **ps_checkout mode**
- Otherwise → **standalone mode**

### B) Track the “last clicked option”
Listen to `pointerdown` + `click` on:
- `input[name="payment-option"]`
- `label[for="payment-option-X"]`
- `.payment-option` (themes that intercept clicks)
Store:
- in memory + `sessionStorage` (`jsrequired:lastChoice`)

### C) Async verification
- first check after a short delay
- retries every fixed interval for a few seconds
- if the expected widget is detected → OK (re-enable Place order)
- otherwise → show the blocking message + keep Place order disabled

### D) DOM scope (per option)
For `payment-option-X`, the module checks the union of:
- `#payment-option-X-container`
- `#pay-with-payment-option-X-form`
- `#payment-option-X-additional-information`
Fallback: global payment block if none exists

### E) Provider heuristics (examples)
- **Revolut**: container exists but empty, no iframe after timeout, `ERR_BLOCKED_BY_CLIENT` to `merchant.revolut.com`
- **Stripe**: missing `.StripeElement`, `#payment-element`, iframe `stripe.com`, `ERR_BLOCKED_BY_CLIENT` to `js.stripe.com`
- **PayPal**: avoids BNPL/marketing iframes, considers OK only when real buttons/checkout render, blocked `paypal.com/sdk/js`
- **ps_checkout**: supports “blank checkout” when no option is available while the section is visible

---

## Test matrix

### Standalone
- Block `merchant.revolut.com` → click Revolut → Revolut message
- Block `js.stripe.com` → click Stripe → Stripe message
- Block `paypal.com/sdk/js` → click PayPal → PayPal message

### ps_checkout
- Simulate blocked checkout scripts/iframes → **blank checkout** (no clickable option) → generic ps_checkout message

### No blocking
- No message displayed
- **Place order** enabled and checkout works normally

---

## FAQ / Troubleshooting

### “The message takes a moment to appear — is that expected?”
Yes. Payment widgets render asynchronously; the module waits briefly to avoid false positives.  
To prevent confusing failures, **Place order is disabled immediately on click** during verification.

### “The wrong provider message is shown”
This can happen if provider markers are detected outside the clicked option scope.  
jsrequired only scans the option’s dedicated scope (container/form/additional) to prevent cross-option false positives.

### “My theme uses a non-standard Place order button”
Open an issue and include:
- PrestaShop version
- theme name
- active payment modules
- browser + blocking extension
- jsrequired diagnostic (Debug ON)

---

## Security & data

- No payment data is collected.
- Diagnostics (only in Debug mode and only when blocked) typically include:
  - provider, option id, moduleName, URL, userAgent, version, timestamp,
  - and a technical reason (missing widget / blocked resource).
- Anti-abuse token used for diagnostics: `JSREQUIRED_DIAG_TOKEN`.

---

## Contributing

Issues and PRs are welcome.  
For faster support, include:
- PrestaShop version
- theme
- enabled payment modules
- browser + blocking extensions
- jsrequired diagnostic output (Debug ON)

---

## License

To be defined by the repository owner (MIT is common).  
Add a `LICENSE` file at the root and update this section accordingly.
